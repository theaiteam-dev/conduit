/**
 * Cache-aware token budgets (issue #125, ADR-0014).
 *
 * `budgets.run.max_tokens` and `budgets.per_wave.max_tokens` compare against a
 * WEIGHTED total: uncached input and output count at 1, cache reads and cache
 * creation at weights resolved per call from the adapter that billed it
 * (worker/adapter-cache-weights.ts), unless the flow's
 * `budgets.token_weights` sets a class, which then applies to every adapter.
 * The journal keeps the raw figures; only the budget accumulators
 * (`tokensSpent`, the per-card wave tokens, and the journal-derived figures in
 * run/run-passes.ts) use this weighting.
 *
 * Missing data never lowers the count. A call whose adapter reports no cache
 * breakdown counts its whole total at weight 1, a breakdown whose classes sum
 * to less than the reported total counts the difference at weight 1, and a
 * span whose adapter is unknown gets weight 1 for each class the flow does not
 * set.
 */
import type { UsageBreakdown } from '../worker/harness-adapter';
import type { ModelResponse } from '../worker/adapter';
import { adapterCacheWeights } from '../worker/adapter-cache-weights';

/** Per-class budget weights. Uncached input and output always weigh 1. */
export interface TokenWeights {
  cacheRead: number;
  cacheCreation: number;
}

/** Cache reads never cost more than uncached input. */
export const MAX_CACHE_READ_WEIGHT = 1;
/** Anthropic's 1-hour cache writes bill at 2x input; 5-minute writes at 1.25x. */
export const MAX_CACHE_CREATION_WEIGHT = 2;

/** The flow.yaml shape: `budgets.token_weights`. */
export interface FlowTokenWeights {
  cache_read?: number;
  cache_creation?: number;
}

/**
 * The weights for a call billed by `adapterName`: each class the flow sets
 * overrides the adapter's default, and a class it leaves unset takes the
 * adapter's default (weight 1 for an unknown adapter).
 */
export function resolveTokenWeights(
  override: FlowTokenWeights | undefined,
  adapterName: string | null | undefined,
): TokenWeights {
  const defaults = adapterCacheWeights(adapterName);
  return {
    cacheRead: override?.cache_read ?? defaults.cacheRead,
    cacheCreation: override?.cache_creation ?? defaults.cacheCreation,
  };
}

/** One adapter's share of a run's spend, split by class (issue #125). */
export interface AdapterUsage {
  /** The adapter that billed it; null when the journal recorded none. */
  adapter: string | null;
  breakdown: UsageBreakdown;
  /**
   * False when some span in this share recorded no cache columns, so its
   * `inputTokens` may include cached tokens and the share has no cache-read
   * figure to report. Budgets ignore it; only the subflow roll-up span's
   * reported split does not. Absent counts as true.
   */
  cacheSplit?: boolean;
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

/** Every class is a finite, non-negative number; otherwise the breakdown is ignored. */
export function isUsableBreakdown(breakdown: UsageBreakdown): boolean {
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = breakdown;
  return [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens].every(isUsableCount);
}

/**
 * The part of a reported total its breakdown does not account for, never
 * negative. Counted at weight 1 by the budgets, and journaled in the span's
 * `input_tokens` (executor `harnessJournalUsage`), so a journal-derived budget
 * counts it too.
 */
export function unaccountedTokens(tokens: number, breakdown: UsageBreakdown): number {
  const classes =
    breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheReadInputTokens + breakdown.cacheCreationInputTokens;
  return Math.max(0, tokens - classes);
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
  if (breakdown === undefined || !isUsableBreakdown(breakdown)) return tokens;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = breakdown;
  const unaccounted = unaccountedTokens(tokens, breakdown);
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
