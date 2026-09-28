/**
 * Claude stream-json -> HarnessEvent mapper (issue #70).
 *
 * The fixture is a REAL `claude -p --output-format stream-json --verbose` run
 * (claude 2.1.283, claude-haiku-4-5) that made two Bash calls (one failing) and
 * one Write call and replied with text. It was scrubbed of session ids, uuids,
 * request/message ids, thinking signatures, paths and account connectors; the
 * structure is as the CLI emitted it. Whole content blocks only: the adapter
 * does not pass --include-partial-messages (decision 1).
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mapClaudeStreamLine, rateLimitWindowsFromInfo } from './harness-events-claude';
import type { HarnessEventBody } from './harness-events';

const FIXTURE = join(import.meta.dir, '..', '..', 'fixtures', 'harness', 'claude-stream-json.ndjson');
const fixtureLines = (): string[] => readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.length > 0);

const line = (obj: unknown): string => JSON.stringify(obj);

describe('mapClaudeStreamLine: the recorded run', () => {
  it('maps every line to the expected event classes, in stream order', () => {
    const events = fixtureLines().flatMap(mapClaudeStreamLine);

    expect(events.map((e) => e.type)).toEqual([
      'reasoning-delta',
      'tool-input-start', 'tool-input-available', 'tool-output-available',
      'tool-input-start', 'tool-input-available', 'tool-output-available',
      'rate-limit',
      'reasoning-delta',
      'tool-input-start', 'tool-input-available', 'tool-output-available',
      'reasoning-delta',
      'text-delta',
      'usage',
    ]);
  });

  it('pairs each tool call with its result by toolCallId and carries the error flag', () => {
    const events = fixtureLines().flatMap(mapClaudeStreamLine);
    const calls = events.filter((e) => e.type === 'tool-input-available');
    const outputs = events.filter((e) => e.type === 'tool-output-available');

    expect(calls.map((c) => c.toolName)).toEqual(['Bash', 'Bash', 'Write']);
    expect(outputs.map((o) => o.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
    expect(outputs.map((o) => o.isError)).toEqual([false, true, false]);
    expect(calls[0]!.input).toEqual({ command: 'echo hello-conduit', description: 'Echo hello-conduit' });
    // The raw tool_use_result rides along as the CLI wrote it (decision 6):
    // an object for a clean Bash call, a bare string for the failed one.
    expect(outputs[0]!.toolUseResult).toMatchObject({ stdout: 'hello-conduit', stderr: '' });
    expect(outputs[1]!.toolUseResult).toContain('Exit code 2');
  });

  it('never throws on any recorded line', () => {
    for (const l of fixtureLines()) expect(() => mapClaudeStreamLine(l)).not.toThrow();
  });
});

describe('mapClaudeStreamLine: per event class', () => {
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
    line({ type: 'assistant', uuid: 'u-1', message: { id: 'msg_1', role: 'assistant', content }, ...extra });

  it('a text block becomes one text-delta carrying the whole block', () => {
    expect(mapClaudeStreamLine(assistant([{ type: 'text', text: 'All done.' }]))).toEqual([
      { type: 'text-delta', id: 'u-1:0', delta: 'All done.' },
    ]);
  });

  it('a thinking block becomes one reasoning-delta', () => {
    expect(mapClaudeStreamLine(assistant([{ type: 'thinking', thinking: 'plan', signature: 'x' }]))).toEqual([
      { type: 'reasoning-delta', id: 'u-1:0', delta: 'plan' },
    ]);
  });

  it('a tool_use block becomes tool-input-start then tool-input-available', () => {
    const events = mapClaudeStreamLine(
      assistant([{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }]),
    );
    expect(events).toEqual([
      { type: 'tool-input-start', toolCallId: 'toolu_9', toolName: 'Bash' },
      { type: 'tool-input-available', toolCallId: 'toolu_9', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('keys block ids by line and block index, so blocks of one message never collide', () => {
    const events = mapClaudeStreamLine(
      assistant([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    );
    expect(events.map((e) => (e as { id: string }).id)).toEqual(['u-1:0', 'u-1:1']);
  });

  it('falls back to the message id when the line has no uuid', () => {
    const events = mapClaudeStreamLine(
      line({ type: 'assistant', message: { id: 'msg_7', content: [{ type: 'text', text: 'x' }] } }),
    );
    expect(events).toEqual([{ type: 'text-delta', id: 'msg_7:0', delta: 'x' }]);
  });

  it('folds a caller-supplied line ordinal into the message-id fallback, so two uuid-less lines sharing a message id do not collide', () => {
    const uuidLess = (text: string): string =>
      line({ type: 'assistant', message: { id: 'msg_7', content: [{ type: 'text', text }] } });

    const first = mapClaudeStreamLine(uuidLess('a'), 0);
    const second = mapClaudeStreamLine(uuidLess('b'), 1);

    expect(first).toEqual([{ type: 'text-delta', id: 'msg_7@0:0', delta: 'a' }]);
    expect(second).toEqual([{ type: 'text-delta', id: 'msg_7@1:0', delta: 'b' }]);
  });

  it('folds the ordinal into the "block" fallback too, when neither uuid nor message id is present', () => {
    const noId = (text: string): string => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

    const first = mapClaudeStreamLine(noId('a'), 0);
    const second = mapClaudeStreamLine(noId('b'), 1);

    expect(first).toEqual([{ type: 'text-delta', id: 'block@0:0', delta: 'a' }]);
    expect(second).toEqual([{ type: 'text-delta', id: 'block@1:0', delta: 'b' }]);
  });

  it('a user tool_result becomes tool-output-available with the raw tool_use_result', () => {
    const events = mapClaudeStreamLine(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'out', is_error: false }],
        },
        tool_use_result: { stdout: 'out', stderr: '', interrupted: false },
      }),
    );
    expect(events).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'toolu_9',
        output: 'out',
        isError: false,
        toolUseResult: { stdout: 'out', stderr: '', interrupted: false },
      },
    ]);
  });

  it('omits toolUseResult when the message carries none, and reads a missing is_error as false', () => {
    const events = mapClaudeStreamLine(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [] }] } }),
    );
    expect(events).toEqual([{ type: 'tool-output-available', toolCallId: 't', output: [], isError: false }]);
  });

  it('does not attribute one tool_use_result to several tool_result blocks', () => {
    const events = mapClaudeStreamLine(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'x' },
            { type: 'tool_result', tool_use_id: 'b', content: 'y', is_error: true },
          ],
        },
        tool_use_result: { stdout: 'x' },
      }),
    );
    expect(events).toEqual([
      { type: 'tool-output-available', toolCallId: 'a', output: 'x', isError: false },
      { type: 'tool-output-available', toolCallId: 'b', output: 'y', isError: true },
    ]);
  });

  it('a result event becomes one usage event with the four classes, their total and the cost', () => {
    const events = mapClaudeStreamLine(
      line({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.05,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      }),
    );
    expect(events).toEqual([
      {
        type: 'usage',
        tokens: 100,
        breakdown: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
        costUsd: 0.05,
      },
    ]);
  });

  it('a result without a usage object yields no usage event, and a non-numeric cost is left out', () => {
    expect(mapClaudeStreamLine(line({ type: 'result', subtype: 'error_during_execution' }))).toEqual([]);
    expect(
      mapClaudeStreamLine(line({ type: 'result', usage: { input_tokens: 1 }, total_cost_usd: 'n/a' })),
    ).toEqual([
      {
        type: 'usage',
        tokens: 1,
        breakdown: { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    ]);
  });

  it('a rate_limit_event becomes one rate-limit event, flat window first', () => {
    const events = mapClaudeStreamLine(
      line({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          isUsingOverage: false,
          rateLimitType: 'five_hour',
          utilization: 0.9,
          resetsAt: 100,
          unifiedWindows: {
            five_hour: { utilization: 0.1, resetsAt: 1 },
            seven_day: { utilization: 0.5, resetsAt: 200 },
          },
        },
      }),
    );
    expect(events).toEqual([
      {
        type: 'rate-limit',
        status: 'allowed_warning',
        usingOverage: false,
        windows: [
          { name: 'five_hour', utilization: 0.9, resetsAtMs: 100_000 },
          { name: 'seven_day', utilization: 0.5, resetsAtMs: 200_000 },
        ],
      },
    ]);
  });
});

describe('mapClaudeStreamLine: lines it does not understand', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace', '   '],
    ['not json', 'Error: something on stdout'],
    ['truncated json', '{"type":"assistant","message":{"content":[{"type":"te'],
    ['json array', '[1,2]'],
    ['json null', 'null'],
    ['json string', '"result"'],
    ['system init', line({ type: 'system', subtype: 'init' })],
    ['unknown type', line({ type: 'stream_event', event: {} })],
    ['assistant without message', line({ type: 'assistant' })],
    ['assistant with string content', line({ type: 'assistant', message: { content: 'hi' } })],
    ['user with string content', line({ type: 'user', message: { content: 'the prompt' } })],
    ['rate_limit_event without info', line({ type: 'rate_limit_event' })],
    ['result with usage array', line({ type: 'result', usage: [] })],
  ];

  for (const [name, input] of cases) {
    it(`${name}: zero events`, () => {
      expect(mapClaudeStreamLine(input)).toEqual([]);
    });
  }

  it('skips a malformed block but keeps the well-formed blocks beside it', () => {
    const events: HarnessEventBody[] = mapClaudeStreamLine(
      line({
        type: 'assistant',
        uuid: 'u',
        message: {
          content: [
            null,
            { type: 'text', text: 42 },
            { type: 'tool_use', name: 'Bash' },
            { type: 'image', source: {} },
            { type: 'text', text: 'kept' },
          ],
        },
      }),
    );
    expect(events).toEqual([{ type: 'text-delta', id: 'u:4', delta: 'kept' }]);
  });

  it('skips a tool_result without a tool_use_id', () => {
    expect(
      mapClaudeStreamLine(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })),
    ).toEqual([]);
  });
});

describe('rateLimitWindowsFromInfo', () => {
  it('reads the nested windows when the flat fields are absent', () => {
    expect(
      rateLimitWindowsFromInfo({ unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 5 } } }),
    ).toEqual([{ name: 'seven_day', utilization: 0.2, resetsAtMs: 5000 }]);
  });

  it('names an unlabelled flat window "window" and skips incomplete nested ones', () => {
    expect(
      rateLimitWindowsFromInfo({ utilization: 1, resetsAt: 2, unifiedWindows: { x: { utilization: 0.1 } } }),
    ).toEqual([{ name: 'window', utilization: 1, resetsAtMs: 2000 }]);
  });
});
