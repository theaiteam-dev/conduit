/**
 * Cache-aware token budgets (issue #125, ADR-0014).
 *
 * `budgets.run.max_tokens` and `budgets.per_wave.max_tokens` compare against a
 * WEIGHTED total: uncached input and output count at 1, cache reads at
 * `budgets.token_weights.cache_read` (default 0.1) and cache creation at
 * `budgets.token_weights.cache_creation` (default 1). The journal keeps the raw
 * figures; only the budget accumulators (`tokensSpent`, the per-card wave
 * tokens, and the journal-derived remaining budget of a run that takes passes)
 * use this weighting.
 *
 * Missing data never lowers the count. A call whose adapter reports no cache
 * breakdown counts its whole total at weight 1, and a breakdown whose classes
 * sum to less than the reported total counts the difference at weight 1.
 */
import type { UsageBreakdown } from '../worker/harness-adapter';
import type { ModelResponse } from '../worker/adapter';

/** Per-class budget weights. Uncached input and output always weigh 1. */
export interface TokenWeights {
  cacheRead: number;
  cacheCreation: number;
}

/** Cache reads bill at about a tenth of the input price on Anthropic models. */
export const DEFAULT_CACHE_READ_WEIGHT = 0.1;
/** Unchanged from before issue #125: cache creation counts as input. */
export const DEFAULT_CACHE_CREATION_WEIGHT = 1;
/** Cache reads never cost more than uncached input. */
export const MAX_CACHE_READ_WEIGHT = 1;
/** Anthropic's 1-hour cache writes bill at 2x input; 5-minute writes at 1.25x. */
export const MAX_CACHE_CREATION_WEIGHT = 2;

export const DEFAULT_TOKEN_WEIGHTS: Readonly<TokenWeights> = Object.freeze({
  cacheRead: DEFAULT_CACHE_READ_WEIGHT,
  cacheCreation: DEFAULT_CACHE_CREATION_WEIGHT,
});

/** The flow.yaml shape: `budgets.token_weights`. */
export interface FlowTokenWeights {
  cache_read?: number;
  cache_creation?: number;
}

/** The weights a flow's budgets use, defaults filled in. */
export function resolveTokenWeights(raw: FlowTokenWeights | undefined): TokenWeights {
  return {
    cacheRead: raw?.cache_read ?? DEFAULT_CACHE_READ_WEIGHT,
    cacheCreation: raw?.cache_creation ?? DEFAULT_CACHE_CREATION_WEIGHT,
  };
}

/**
 * Validate an untrusted `budgets.token_weights` block. Returns one message per
 * problem; empty means valid. Absent is valid (defaults apply).
 */
export function validateTokenWeights(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['budgets.token_weights must be a mapping with cache_read and/or cache_creation'];
  }
  const errors: string[] = [];
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (key !== 'cache_read' && key !== 'cache_creation') {
      errors.push(`budgets.token_weights has unknown key '${key}' (expected cache_read or cache_creation)`);
    }
  }
  const check = (key: string, max: number): void => {
    const value = block[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
      errors.push(`budgets.token_weights.${key} must be a number from 0 to ${max}, got ${JSON.stringify(value)}`);
    }
  };
  check('cache_read', MAX_CACHE_READ_WEIGHT);
  check('cache_creation', MAX_CACHE_CREATION_WEIGHT);
  return errors;
}

function isUsableCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * The budget figure for one harness call (or a subflow roll-up), from its raw
 * total and optional per-class breakdown.
 *
 * - No breakdown, or one with a non-numeric or negative class: the raw total
 *   at weight 1.
 * - Otherwise each class at its weight, plus any part of the total the classes
 *   do not account for at weight 1, so a partial breakdown cannot shrink the
 *   count below what the adapter reported.
 */
export function weightedUsageTokens(
  tokens: number,
  breakdown: UsageBreakdown | undefined,
  weights: TokenWeights,
): number {
  if (breakdown === undefined) return tokens;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = breakdown;
  if (![inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens].every(isUsableCount)) {
    return tokens;
  }
  const classes = inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const unaccounted = Math.max(0, tokens - classes);
  const cacheRead = weights.cacheRead * cacheReadInputTokens;
  const cacheCreation = weights.cacheCreation * cacheCreationInputTokens;
  return inputTokens + outputTokens + cacheRead + cacheCreation + unaccounted;
}

/**
 * The budget figure for one transform call. With no cache split reported,
 * `inputTokens` may include cached tokens, so it counts at weight 1.
 */
export function weightedModelResponseTokens(response: ModelResponse, weights: TokenWeights): number {
  const cacheRead = response.cacheReadInputTokens ?? 0;
  return response.inputTokens + response.outputTokens + weights.cacheRead * cacheRead;
}

/** Render a weight for status lines: `0.1`, `1`, `1.25`. */
export function formatWeight(w: number): string {
  return String(Number(w.toFixed(4)));
}
