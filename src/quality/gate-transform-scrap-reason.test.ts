/**
 * Issue #42: a transform gate critic that fails scraps under a named reason
 * per failure class, not the maker convention `model-incompatible`.
 *
 *   - parseable, schema-invalid on every attempt -> `critic-verdict-invalid: <validator error>`
 *   - a reject with missing or empty findings    -> `critic-reject-without-findings: <REJECT_WITHOUT_FINDINGS_ERROR>`
 *   - never parseable                            -> `critic-verdict-unparseable`
 *   - finish_reason: length, no valid answer     -> `critic-output-truncated`
 *   - adapter refuses image input                -> `critic-vision-unsupported`
 *
 * The harness critic's `harness-critic-*` reasons are pinned in checks.test.ts
 * and gate-rework-harness-scrap-reason.test.ts and are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter, ModelResponse } from '../worker/adapter';
import { runGateCheck, REJECT_WITHOUT_FINDINGS_ERROR, type GateConfig, type GateDecision } from './gate';

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

function resp(text: string, over: Partial<ModelResponse> = {}): ModelResponse {
  return { text, inputTokens: 10, outputTokens: 5, costUsd: 0.001, ...over };
}

/** Returns the queued responses in order; a thrown value is thrown from call(). */
function queuedAdapter(queue: Array<ModelResponse | Error>): { adapter: ModelAdapter; calls: () => number } {
  let i = 0;
  return {
    adapter: {
      async call() {
        const next = queue[i++];
        if (next === undefined) throw new Error(`stub adapter over-called: call #${i}`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
    calls: () => i,
  };
}

function config(adapter: ModelAdapter, over: Partial<GateConfig> = {}): GateConfig {
  return {
    cardId: 'card-1',
    station: 'gate',
    runId: DEFAULT_RUN_ID,
    attempt: 0,
    maxExecutionAttempts: 3,
    model: 'critic-model',
    prompt: 'Judge the draft.',
    params: {},
    adapter,
    db,
    onReject: 'draft',
    validBackEdges: [{ from: 'gate', to: 'draft' }],
    ...over,
  };
}

function scrapReason(d: GateDecision): string {
  if (d.action !== 'scrapped') throw new Error(`expected a scrap, got ${JSON.stringify(d)}`);
  return d.reason;
}

describe('runGateCheck: named scrap reasons for a transform critic (issue #42)', () => {
  it('a parseable but schema-invalid verdict on every attempt scraps as critic-verdict-invalid with the validator error', async () => {
    const { adapter, calls } = queuedAdapter([resp('{"accept":true}'), resp('{"accept":true}'), resp('{"accept":true}')]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe('critic-verdict-invalid: verdict must be "pass" or "reject"');
    // Retry semantics are unchanged: every attempt up to the cap was spent.
    expect(calls()).toBe(3);
  });

  it('a reject verdict with its findings under the wrong key scraps as critic-reject-without-findings', async () => {
    const bad = '{"verdict":"reject","reasons":["too short"]}';
    const { adapter } = queuedAdapter([resp(bad), resp(bad), resp(bad)]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe(`critic-reject-without-findings: ${REJECT_WITHOUT_FINDINGS_ERROR}`);
  });

  it('reports the most recent validation error when a later attempt is unparseable', async () => {
    const { adapter } = queuedAdapter([resp('{"verdict":"maybe","findings":[]}'), resp('not json'), resp('still not json')]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe('critic-verdict-invalid: verdict must be "pass" or "reject"');
  });

  it('a verdict that is never parseable scraps as critic-verdict-unparseable', async () => {
    const { adapter } = queuedAdapter([resp('not json'), resp('nope'), resp('<verdict>pass</verdict>')]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe('critic-verdict-unparseable');
  });

  it('finish_reason length with no valid answer scraps as critic-output-truncated, not model-incompatible', async () => {
    const { adapter, calls } = queuedAdapter([resp('{"verdict":"pa', { finishReason: 'length' })]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe('critic-output-truncated');
    // The truncation fast-scrap still spends one call, not the whole budget.
    expect(calls()).toBe(1);
  });

  it('an adapter that refuses image input scraps as critic-vision-unsupported', async () => {
    const visionErr = Object.assign(new Error('model has no vision'), { code: 'vision-unsupported' });
    const { adapter } = queuedAdapter([visionErr]);

    const reason = scrapReason(await runGateCheck(config(adapter)));

    expect(reason).toBe('critic-vision-unsupported');
  });

  it('never reports model-incompatible for a critic failure', async () => {
    const cases: Array<Array<ModelResponse | Error>> = [
      [resp('{"accept":true}'), resp('{"accept":true}'), resp('{"accept":true}')],
      [resp('x'), resp('y'), resp('z')],
      [resp('{', { finishReason: 'length' })],
    ];
    for (const queue of cases) {
      const reason = scrapReason(await runGateCheck(config(queuedAdapter(queue).adapter)));
      expect(reason).not.toBe('model-incompatible');
    }
  });

  it('a transform critic scrap still carries no criticUsage (its spend folds through the tracking adapter)', async () => {
    const { adapter } = queuedAdapter([resp('{"accept":true}'), resp('{"accept":true}'), resp('{"accept":true}')]);

    const decision = await runGateCheck(config(adapter));

    expect(decision.action).toBe('scrapped');
    expect(decision.criticUsage).toBeUndefined();
  });
});

describe('runGateCheck: a transform critic scrap reason carries no model output (issue #42)', () => {
  // The reason is journaled and printed, so it must not quote what the critic
  // model wrote. Each response below fails a different gateCriticSchema check
  // and carries a marker in the value the check rejects.
  const MARKER = 'SECRET-PROMPT-ECHO';
  const shapes: Array<[string, string]> = [
    ['a non-object JSON value', JSON.stringify(MARKER)],
    ['an array', JSON.stringify([MARKER])],
    ['an unknown verdict', JSON.stringify({ verdict: MARKER, findings: [] })],
    ['a reject with findings under another key', JSON.stringify({ verdict: 'reject', reasons: [MARKER] })],
    ['a pass with non-array findings', JSON.stringify({ verdict: 'pass', findings: MARKER })],
  ];

  for (const [label, text] of shapes) {
    it(`does not quote the rejected value for ${label}`, async () => {
      const { adapter } = queuedAdapter([resp(text), resp(text), resp(text)]);

      const reason = scrapReason(await runGateCheck(config(adapter)));

      expect(reason.startsWith('critic-')).toBe(true);
      expect(reason).not.toContain(MARKER);
    });
  }
});
