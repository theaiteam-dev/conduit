/**
 * Issue #156: the transform adapter's cache-read split.
 *
 * Two provider shapes carry a cache-read figure:
 *   - the OpenAI-compatible body, `usage.prompt_tokens_details.cached_tokens`
 *     (OpenAI, xAI, LiteLLM pass-through), where `prompt_tokens` includes the
 *     cached tokens;
 *   - the Fireworks response header `fireworks-cached-prompt-tokens`.
 *
 * The body field wins when both are present. With a split, `inputTokens` is
 * UNCACHED input (issue #5) and `inputTokens + cacheReadInputTokens` equals
 * `prompt_tokens`, so totals do not move. A missing, non-numeric or
 * out-of-range figure records no split (`cacheReadInputTokens` undefined) and
 * leaves `inputTokens` at `prompt_tokens`.
 *
 * The response bodies and headers below are recorded shapes, trimmed to the
 * fields the adapter reads.
 */

import { describe, it, expect } from 'bun:test';
import { createOpenAiAdapter } from './openai-adapter';

const BASE_URL = 'https://gateway.example/v1';
const env = { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };

function adapterReturning(body: unknown, headers: Record<string, string> = {}) {
  const fetchFn = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch;
  return createOpenAiAdapter({ fetchFn, env });
}

async function call(body: unknown, headers: Record<string, string> = {}) {
  return adapterReturning(body, headers).call({ model: 'm', prompt: 'p', params: {} });
}

/** OpenAI chat.completion, as returned with a cache hit (trimmed). */
const OPENAI_CACHED_BODY = {
  id: 'chatcmpl-AbC123',
  object: 'chat.completion',
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 2006,
    completion_tokens: 300,
    total_tokens: 2306,
    prompt_tokens_details: { cached_tokens: 1920, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

/** Fireworks chat.completion body: usage carries no prompt_tokens_details. */
const FIREWORKS_BODY = {
  id: 'f1b2c3',
  object: 'chat.completion',
  model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
  choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
};

const FIREWORKS_HEADERS = {
  'fireworks-prompt-tokens': '1200',
  'fireworks-cached-prompt-tokens': '1024',
};

describe('openai adapter cache-read split (issue #156)', () => {
  it('reads usage.prompt_tokens_details.cached_tokens and narrows inputTokens to uncached input', async () => {
    const res = await call(OPENAI_CACHED_BODY);
    expect(res.cacheReadInputTokens).toBe(1920);
    expect(res.inputTokens).toBe(2006 - 1920);
    expect(res.outputTokens).toBe(300);
    expect(res.inputTokens + res.cacheReadInputTokens!).toBe(2006);
  });

  it('records a cache-read figure of 0 when the body reports cached_tokens: 0', async () => {
    const body = structuredClone(OPENAI_CACHED_BODY);
    body.usage.prompt_tokens_details.cached_tokens = 0;
    const res = await call(body);
    expect(res.cacheReadInputTokens).toBe(0);
    expect(res.inputTokens).toBe(2006);
  });

  it('falls back to the fireworks-cached-prompt-tokens header when the body has no figure', async () => {
    const res = await call(FIREWORKS_BODY, FIREWORKS_HEADERS);
    expect(res.cacheReadInputTokens).toBe(1024);
    expect(res.inputTokens).toBe(1200 - 1024);
    expect(res.outputTokens).toBe(40);
  });

  it('uses the body figure when both the body and the Fireworks header report one', async () => {
    const res = await call(OPENAI_CACHED_BODY, { 'fireworks-cached-prompt-tokens': '5' });
    expect(res.cacheReadInputTokens).toBe(1920);
    expect(res.inputTokens).toBe(86);
  });

  it('records no split when neither the body nor the header reports a figure', async () => {
    const res = await call(FIREWORKS_BODY);
    expect(res.cacheReadInputTokens).toBeUndefined();
    expect(res.inputTokens).toBe(1200);
  });

  it('records no split when prompt_tokens_details is null', async () => {
    const body = { ...FIREWORKS_BODY, usage: { ...FIREWORKS_BODY.usage, prompt_tokens_details: null } };
    const res = await call(body);
    expect(res.cacheReadInputTokens).toBeUndefined();
    expect(res.inputTokens).toBe(1200);
  });

  describe('malformed or out-of-range figures record no split', () => {
    const bodyCases: Array<[string, unknown]> = [
      ['a non-numeric string', 'lots'],
      ['a negative number', -5],
      ['more than prompt_tokens', 2007],
      ['a fraction', 12.5],
      ['an object', { n: 3 }],
      ['NaN encoded as a string', 'NaN'],
    ];
    for (const [label, cached] of bodyCases) {
      it(`body cached_tokens is ${label}`, async () => {
        const body = structuredClone(OPENAI_CACHED_BODY) as { usage: { prompt_tokens_details: { cached_tokens: unknown } } };
        body.usage.prompt_tokens_details.cached_tokens = cached;
        const res = await call(body);
        expect(res.cacheReadInputTokens).toBeUndefined();
        expect(res.inputTokens).toBe(2006);
      });
    }

    it('a malformed body figure does not fall back to the header', async () => {
      const body = structuredClone(OPENAI_CACHED_BODY) as { usage: { prompt_tokens_details: { cached_tokens: unknown } } };
      body.usage.prompt_tokens_details.cached_tokens = 'lots';
      const res = await call(body, { 'fireworks-cached-prompt-tokens': '100' });
      expect(res.cacheReadInputTokens).toBeUndefined();
      expect(res.inputTokens).toBe(2006);
    });

    const headerCases: Array<[string, string]> = [
      ['non-numeric', 'abc'],
      ['negative', '-1'],
      ['more than prompt_tokens', '1201'],
      ['a fraction', '10.5'],
      ['empty', ''],
    ];
    for (const [label, value] of headerCases) {
      it(`fireworks-cached-prompt-tokens is ${label}`, async () => {
        const res = await call(FIREWORKS_BODY, { 'fireworks-cached-prompt-tokens': value });
        expect(res.cacheReadInputTokens).toBeUndefined();
        expect(res.inputTokens).toBe(1200);
      });
    }

    it('a cache figure with no usable prompt_tokens records no split', async () => {
      const body = { ...FIREWORKS_BODY, usage: { completion_tokens: 40 } };
      const res = await call(body, { 'fireworks-cached-prompt-tokens': '10' });
      expect(res.cacheReadInputTokens).toBeUndefined();
      expect(res.inputTokens).toBe(0);
    });
  });

  it('accepts a numeric-string body figure, as the adapter does for prompt_tokens', async () => {
    const body = structuredClone(OPENAI_CACHED_BODY) as { usage: { prompt_tokens_details: { cached_tokens: unknown } } };
    body.usage.prompt_tokens_details.cached_tokens = '1920';
    const res = await call(body);
    expect(res.cacheReadInputTokens).toBe(1920);
    expect(res.inputTokens).toBe(86);
  });
});
