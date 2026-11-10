/**
 * Issue #125 (ADR-0014): the weighting the run and wave budgets apply to
 * cache classes. The executor-level tests (executor-cache-budget.test.ts)
 * prove the accumulator uses it; these pin the arithmetic and validation.
 */
import { describe, it, expect } from 'bun:test';
import {
  resolveTokenWeights,
  validateTokenWeights,
  weightedModelResponseTokens,
  weightedUsageTokens,
  type TokenWeights,
} from './token-weights';

/** Fixed weights for the arithmetic tests below, independent of any adapter default. */
const W: TokenWeights = { cacheRead: 0.1, cacheCreation: 1 };

describe('resolveTokenWeights', () => {
  it("takes the adapter's defaults when the flow sets nothing", () => {
    expect(resolveTokenWeights(undefined, 'claude-headless')).toEqual({ cacheRead: 0.1, cacheCreation: 2 });
    expect(resolveTokenWeights({}, 'codex-app-server')).toEqual({ cacheRead: 0.5, cacheCreation: 1 });
    expect(resolveTokenWeights(undefined, 'openai-compatible')).toEqual({ cacheRead: 1, cacheCreation: 1 });
  });

  it('gives an unknown or missing adapter no discount', () => {
    expect(resolveTokenWeights(undefined, 'some-future-adapter')).toEqual({ cacheRead: 1, cacheCreation: 1 });
    expect(resolveTokenWeights(undefined, null)).toEqual({ cacheRead: 1, cacheCreation: 1 });
    expect(resolveTokenWeights(undefined, 'subflow:./child/flow.yaml')).toEqual({ cacheRead: 1, cacheCreation: 1 });
    expect(resolveTokenWeights(undefined, 'toString')).toEqual({ cacheRead: 1, cacheCreation: 1 });
  });

  it("a class the flow sets overrides every adapter's default, including 0; an unset class falls back", () => {
    expect(resolveTokenWeights({ cache_read: 0 }, 'opencode')).toEqual({ cacheRead: 0, cacheCreation: 1 });
    expect(resolveTokenWeights({ cache_read: 1 }, 'claude-headless')).toEqual({ cacheRead: 1, cacheCreation: 2 });
    expect(resolveTokenWeights({ cache_creation: 1.25 }, 'agent-sdk')).toEqual({ cacheRead: 0.1, cacheCreation: 1.25 });
    expect(resolveTokenWeights({ cache_read: 0.2, cache_creation: 0 }, null)).toEqual({ cacheRead: 0.2, cacheCreation: 0 });
  });
});

describe('validateTokenWeights', () => {
  it('accepts an absent block and in-range weights', () => {
    expect(validateTokenWeights(undefined)).toEqual([]);
    expect(validateTokenWeights({})).toEqual([]);
    expect(validateTokenWeights({ cache_read: 0, cache_creation: 0 })).toEqual([]);
    expect(validateTokenWeights({ cache_read: 1, cache_creation: 2 })).toEqual([]);
  });

  it('rejects negatives, non-numbers, NaN and infinities', () => {
    expect(validateTokenWeights({ cache_read: -0.1 })).toHaveLength(1);
    expect(validateTokenWeights({ cache_read: '0.1' })).toHaveLength(1);
    expect(validateTokenWeights({ cache_creation: null })).toHaveLength(1);
    expect(validateTokenWeights({ cache_read: Number.NaN })).toHaveLength(1);
    expect(validateTokenWeights({ cache_creation: Number.POSITIVE_INFINITY })).toHaveLength(1);
  });

  it('rejects cache_read above 1 and cache_creation above 2', () => {
    expect(validateTokenWeights({ cache_read: 1.01 })[0]).toContain('cache_read must be a number from 0 to 1');
    expect(validateTokenWeights({ cache_creation: 2.5 })[0]).toContain('cache_creation must be a number from 0 to 2');
  });

  it('rejects a non-mapping and unknown keys', () => {
    expect(validateTokenWeights(0.1)).toHaveLength(1);
    expect(validateTokenWeights([0.1])).toHaveLength(1);
    expect(validateTokenWeights(null)).toHaveLength(1);
    expect(validateTokenWeights({ cache_reads: 0.1 })[0]).toContain("unknown key 'cache_reads'");
  });
});

describe('weightedUsageTokens', () => {
  const breakdown = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 40 };

  it('weights each cache class', () => {
    // 100 + 50 + 0.1 * 1000 + 1 * 40
    expect(weightedUsageTokens(1190, breakdown, W)).toBe(290);
    expect(weightedUsageTokens(1190, breakdown, { cacheRead: 0, cacheCreation: 2 })).toBe(230);
  });

  it('is the raw total at weight 1 everywhere', () => {
    expect(weightedUsageTokens(1190, breakdown, { cacheRead: 1, cacheCreation: 1 })).toBe(1190);
  });

  it('counts the whole total at weight 1 when there is no breakdown', () => {
    expect(weightedUsageTokens(1190, undefined, W)).toBe(1190);
  });

  it('counts the part of the total the breakdown does not account for at weight 1', () => {
    // Classes sum to 1190; the reported total is 1500, so 310 more at 1.
    expect(weightedUsageTokens(1500, breakdown, W)).toBe(600);
  });

  it('does not subtract when the classes sum to more than the total', () => {
    expect(weightedUsageTokens(100, breakdown, W)).toBe(290);
  });

  it('falls back to the raw total when a class is unusable', () => {
    expect(weightedUsageTokens(1190, { ...breakdown, cacheReadInputTokens: -5 }, W)).toBe(1190);
    expect(weightedUsageTokens(1190, { ...breakdown, cacheReadInputTokens: Number.NaN }, W)).toBe(1190);
  });
});

describe('weightedModelResponseTokens', () => {
  it('weights cache reads when the transform call reported a split', () => {
    const r = { text: '', inputTokens: 4, cacheReadInputTokens: 10, outputTokens: 6, costUsd: 0 };
    expect(weightedModelResponseTokens(r, W)).toBe(11);
    expect(weightedModelResponseTokens(r, { cacheRead: 1, cacheCreation: 1 })).toBe(20);
  });

  it('counts all input at weight 1 when no split was reported', () => {
    const r = { text: '', inputTokens: 14, outputTokens: 6, costUsd: 0 };
    expect(weightedModelResponseTokens(r, W)).toBe(20);
  });
});
