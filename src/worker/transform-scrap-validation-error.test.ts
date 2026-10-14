/**
 * Issue #42: a `model-incompatible` scrap from runTransformStation carries the
 * validator error of the most recent response that parsed, so a caller (the
 * transform gate critic) can name what was wrong with the shape. A response
 * that never parsed leaves the field absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter, ModelResponse } from './adapter';
import { runTransformStation, type OutputSchema, type TransformContext } from './transform';

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

const schema: OutputSchema<{ idea: string }> = {
  validate(value) {
    if (value === null || typeof value !== 'object') return { ok: false, error: 'expected object' };
    const v = value as Record<string, unknown>;
    if (typeof v.idea !== 'string') return { ok: false, error: 'idea must be a string' };
    return { ok: true, value: { idea: v.idea } };
  },
};

function adapterReturning(texts: string[]): ModelAdapter {
  let i = 0;
  return {
    async call(): Promise<ModelResponse> {
      const text = texts[i++];
      if (text === undefined) throw new Error('stub adapter over-called');
      return { text, inputTokens: 1, outputTokens: 1, costUsd: 0 };
    },
  };
}

function ctx(adapter: ModelAdapter): TransformContext<{ idea: string }> {
  return {
    cardId: 'c1',
    station: 's',
    runId: DEFAULT_RUN_ID,
    attempt: 0,
    maxExecutionAttempts: 2,
    model: 'm',
    prompt: 'p',
    params: {},
    schema,
    adapter,
    db,
  };
}

describe('runTransformStation: validationError on a model-incompatible scrap (issue #42)', () => {
  it('carries the validator error when a response parsed but failed the schema', async () => {
    const result = await runTransformStation(ctx(adapterReturning(['{"nope":1}', '{"nope":2}'])));

    expect(result).toEqual({
      status: 'scrapped',
      reason: 'model-incompatible',
      attempts: 2,
      validationError: 'idea must be a string',
    });
  });

  it('omits validationError when no response parsed', async () => {
    const result = await runTransformStation(ctx(adapterReturning(['garbage', 'more garbage'])));

    expect(result).toEqual({ status: 'scrapped', reason: 'model-incompatible', attempts: 2 });
  });
});
