/**
 * Each shipped adapter's default budget weights for cache classes (issue
 * #125, ADR-0014). This table is the one place an adapter declares them; a
 * flow's `budgets.token_weights` overrides a class for every adapter
 * (control/token-weights.ts `resolveTokenWeights`).
 *
 * Keyed by the adapter name the journal records on a span (`journal.adapter`),
 * so a journal-derived budget can find the same weights the executor used.
 * Every name in `SHIPPED_HARNESS_FACTORIES` must have an entry
 * (adapter-cache-weights.test.ts enforces it), plus the transform adapter.
 *
 * Each default is the least favourable price ratio the adapter's possible
 * providers bill, so a default never counts less than the call spent:
 *
 *   - claude-headless, agent-sdk: Anthropic. Cache reads bill at 0.1x input.
 *     Cache writes bill at 1.25x (5-minute TTL) or 2x (1-hour TTL); the
 *     recorded Claude Code stream (fixtures/harness/claude-stream-json.ndjson)
 *     writes only `ephemeral_1h_input_tokens`, so 2.
 *   - codex-exec, codex-app-server: OpenAI. The cached-input discount is 50%
 *     to 90% by model, so 0.5. OpenAI does not bill cache writes above input.
 *   - opencode and the transform adapter: the billing provider is whatever the
 *     model string or gateway routes to, so nothing is discounted.
 */
import type { TokenWeights } from '../control/token-weights';

/** The name the transform path's budget weighting uses for its adapter. */
export const TRANSFORM_ADAPTER_NAME = 'openai-compatible';

/** Weights for a span whose adapter is unknown or not in the table: no discount. */
export const UNKNOWN_ADAPTER_CACHE_WEIGHTS: Readonly<TokenWeights> = Object.freeze({ cacheRead: 1, cacheCreation: 1 });

export const ADAPTER_CACHE_WEIGHTS: Readonly<Record<string, Readonly<TokenWeights>>> = Object.freeze({
  'claude-headless': { cacheRead: 0.1, cacheCreation: 2 },
  'agent-sdk': { cacheRead: 0.1, cacheCreation: 2 },
  'codex-exec': { cacheRead: 0.5, cacheCreation: 1 },
  'codex-app-server': { cacheRead: 0.5, cacheCreation: 1 },
  opencode: { cacheRead: 1, cacheCreation: 1 },
  [TRANSFORM_ADAPTER_NAME]: { cacheRead: 1, cacheCreation: 1 },
});

/** An adapter's default weights; an unknown or missing name gets no discount. */
export function adapterCacheWeights(adapterName: string | null | undefined): Readonly<TokenWeights> {
  if (adapterName == null || !Object.prototype.hasOwnProperty.call(ADAPTER_CACHE_WEIGHTS, adapterName)) {
    return UNKNOWN_ADAPTER_CACHE_WEIGHTS;
  }
  return ADAPTER_CACHE_WEIGHTS[adapterName]!;
}
