/**
 * Issue #125: every shipped harness adapter declares its default cache
 * weights, so a new adapter cannot ship without choosing them.
 */
import { describe, it, expect } from 'bun:test';
import { shippedHarnessAdapterNames } from './harness-adapter';
import { ADAPTER_CACHE_WEIGHTS, TRANSFORM_ADAPTER_NAME, adapterCacheWeights } from './adapter-cache-weights';
import { MAX_CACHE_CREATION_WEIGHT, MAX_CACHE_READ_WEIGHT } from '../control/token-weights';

describe('adapter cache weights', () => {
  it('has an entry for every shipped harness adapter and the transform adapter', () => {
    const declared = Object.keys(ADAPTER_CACHE_WEIGHTS).sort();
    expect(declared).toEqual([...shippedHarnessAdapterNames(), TRANSFORM_ADAPTER_NAME].sort());
  });

  it('keeps every default inside the range a flow may set', () => {
    for (const w of Object.values(ADAPTER_CACHE_WEIGHTS)) {
      expect(w.cacheRead).toBeGreaterThanOrEqual(0);
      expect(w.cacheRead).toBeLessThanOrEqual(MAX_CACHE_READ_WEIGHT);
      expect(w.cacheCreation).toBeGreaterThanOrEqual(0);
      expect(w.cacheCreation).toBeLessThanOrEqual(MAX_CACHE_CREATION_WEIGHT);
    }
  });

  it('pins the defaults ADR-0014 records', () => {
    expect(ADAPTER_CACHE_WEIGHTS).toEqual({
      'claude-headless': { cacheRead: 0.1, cacheCreation: 2 },
      'agent-sdk': { cacheRead: 0.1, cacheCreation: 2 },
      'codex-exec': { cacheRead: 0.5, cacheCreation: 1 },
      'codex-app-server': { cacheRead: 0.5, cacheCreation: 1 },
      opencode: { cacheRead: 1, cacheCreation: 1 },
      'openai-compatible': { cacheRead: 1, cacheCreation: 1 },
    });
  });

  it('gives an unknown name no discount', () => {
    expect(adapterCacheWeights('fake-harness')).toEqual({ cacheRead: 1, cacheCreation: 1 });
    expect(adapterCacheWeights(undefined)).toEqual({ cacheRead: 1, cacheCreation: 1 });
  });
});
