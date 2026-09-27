/**
 * Tests for the subject-identity fields on a webhook ingress binding (issue #36):
 * `run_key`, `when`, and `max_passes`.
 *
 * All three are webhook-only in this change and are validated at boot with
 * stable error codes, in the same never-throw, typed-error style as the rest of
 * binding.ts:
 *
 *   INVALID_RUN_KEY            malformed run_key (not a non-empty list of parts)
 *   RUN_KEY_UNSUPPORTED_TYPE   run_key on a slack or cli binding
 *   INVALID_WHEN               malformed when condition
 *   WHEN_UNSUPPORTED_TYPE      when on a slack or cli binding
 *   INVALID_MAX_PASSES         not a positive integer, or declared without run_key,
 *                              or on a non-webhook binding
 *   RESERVED_SUBSTRATE_FIELD   a keyed binding's substrate mapping names
 *                              `run_key`, `pass`, `events` or
 *                              `events_truncated`, which the listener stamps
 */
import { describe, it, expect } from 'bun:test';
import { parseIngressBinding, validateIngressBindings } from './binding';

const webhookBase = {
  type: 'webhook',
  route: '/hooks/pr',
  auth: { type: 'hmac', secret_env: 'PR_SECRET' },
  event_id: { from: 'header', name: 'x-github-delivery' },
};

function parseErrorCode(raw: unknown): string {
  const result = parseIngressBinding(raw);
  if (result.ok) throw new Error('expected a parse failure');
  return result.error.code;
}

describe('run_key', () => {
  it('parses json_path parts (string and alternatives) and header parts, in order', () => {
    const result = parseIngressBinding({
      ...webhookBase,
      run_key: [
        { json_path: '$.repository.id' },
        { json_path: ['$.pull_request.number', '$.issue.number'] },
        { header: 'X-GitHub-Hook-ID' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.run_key).toEqual([
      { json_path: ['$.repository.id'] },
      { json_path: ['$.pull_request.number', '$.issue.number'] },
      { header: 'X-GitHub-Hook-ID' },
    ]);
  });

  it('leaves run_key absent when not declared', () => {
    const result = parseIngressBinding(webhookBase);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('run_key' in result.binding).toBe(false);
    expect('when' in result.binding).toBe(false);
    expect('max_passes' in result.binding).toBe(false);
  });

  it.each([
    ['not a list', { json_path: '$.a' }],
    ['an empty list', []],
    ['a part that is not an object', ['$.a']],
    ['a part naming both sources', [{ json_path: '$.a', header: 'x' }]],
    ['a part naming no source', [{}]],
    ['a part with an unknown key', [{ json_path: '$.a', default: 'x' }]],
    ['a json_path not rooted at $.', [{ json_path: 'a.b' }]],
    ['an empty alternatives list', [{ json_path: [] }]],
    ['a non-string alternative', [{ json_path: ['$.a', 3] }]],
    ['an empty header name', [{ header: '' }]],
    ['a non-string header', [{ header: 7 }]],
  ])('rejects %s with INVALID_RUN_KEY', (_label, runKey) => {
    expect(parseErrorCode({ ...webhookBase, run_key: runKey })).toBe('INVALID_RUN_KEY');
  });

  it('rejects run_key on a slack binding with RUN_KEY_UNSUPPORTED_TYPE', () => {
    expect(
      parseErrorCode({
        type: 'slack',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
        run_key: [{ json_path: '$.event.channel' }],
      }),
    ).toBe('RUN_KEY_UNSUPPORTED_TYPE');
  });

  it('rejects run_key on a cli binding with RUN_KEY_UNSUPPORTED_TYPE', () => {
    expect(
      parseErrorCode({
        type: 'cli',
        event_id: { from: 'content_hash' },
        run_key: [{ json_path: '$.id' }],
      }),
    ).toBe('RUN_KEY_UNSUPPORTED_TYPE');
  });

  it('surfaces the code through validateIngressBindings naming the flow', () => {
    const result = validateIngressBindings([
      { flow: 'pr-loop', ingress: { ...webhookBase, run_key: [] } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_RUN_KEY');
    expect(result.errors[0]!.message).toContain('pr-loop');
  });

  it('reserves the stamped substrate field names on a keyed binding', () => {
    expect(
      parseErrorCode({
        ...webhookBase,
        run_key: [{ json_path: '$.id' }],
        substrate: { pass: '$.body.pass' },
      }),
    ).toBe('RESERVED_SUBSTRATE_FIELD');
    expect(
      parseErrorCode({
        ...webhookBase,
        run_key: [{ json_path: '$.id' }],
        substrate: { run_key: '$.body.key' },
      }),
    ).toBe('RESERVED_SUBSTRATE_FIELD');
    for (const name of ['events', 'events_truncated']) {
      expect(
        parseErrorCode({
          ...webhookBase,
          run_key: [{ json_path: '$.id' }],
          substrate: { [name]: '$.body.x' },
        }),
      ).toBe('RESERVED_SUBSTRATE_FIELD');
    }
  });

  it('leaves those names free on an unkeyed binding', () => {
    const result = parseIngressBinding({ ...webhookBase, substrate: { pass: '$.body.pass' } });
    expect(result.ok).toBe(true);
  });
});

describe('when', () => {
  it('parses header and json_path conditions with in / not_in / present, stringifying scalar values', () => {
    const result = parseIngressBinding({
      ...webhookBase,
      when: [
        { header: 'X-GitHub-Event', in: ['pull_request_review', 'issue_comment'] },
        { json_path: '$.action', not_in: ['deleted'] },
        { json_path: '$.pull_request.number', present: true },
        { json_path: '$.sender.id', in: [42, true] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.when).toEqual([
      { header: 'X-GitHub-Event', in: ['pull_request_review', 'issue_comment'] },
      { json_path: '$.action', not_in: ['deleted'] },
      { json_path: '$.pull_request.number', present: true },
      { json_path: '$.sender.id', in: ['42', 'true'] },
    ]);
  });

  it('works without run_key', () => {
    const result = parseIngressBinding({
      ...webhookBase,
      when: [{ header: 'X-GitHub-Event', in: ['push'] }],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not a list', { header: 'x', in: ['a'] }],
    ['an empty list', []],
    ['a condition that is not an object', ['x']],
    ['a condition with no subject', [{ in: ['a'] }]],
    ['a condition with two subjects', [{ header: 'x', json_path: '$.a', in: ['a'] }]],
    ['a condition with no test', [{ header: 'x' }]],
    ['a condition with two tests', [{ header: 'x', in: ['a'], present: true }]],
    ['an unknown key', [{ header: 'x', in: ['a'], equals: 'a' }]],
    ['an empty in list', [{ header: 'x', in: [] }]],
    ['an empty not_in list', [{ header: 'x', not_in: [] }]],
    ['a non-scalar in value', [{ header: 'x', in: [{ a: 1 }] }]],
    ['a null in value', [{ header: 'x', in: [null] }]],
    ['a non-boolean present', [{ header: 'x', present: 'yes' }]],
    ['a json_path not rooted at $.', [{ json_path: 'action', in: ['a'] }]],
    ['an empty header name', [{ header: '', in: ['a'] }]],
  ])('rejects %s with INVALID_WHEN', (_label, when) => {
    expect(parseErrorCode({ ...webhookBase, when })).toBe('INVALID_WHEN');
  });

  it('rejects when on a slack binding with WHEN_UNSUPPORTED_TYPE', () => {
    expect(
      parseErrorCode({
        type: 'slack',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
        when: [{ json_path: '$.event.type', in: ['message'] }],
      }),
    ).toBe('WHEN_UNSUPPORTED_TYPE');
  });
});

describe('max_passes', () => {
  it('parses a positive integer on a keyed webhook binding', () => {
    const result = parseIngressBinding({
      ...webhookBase,
      run_key: [{ json_path: '$.id' }],
      max_passes: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.max_passes).toBe(10);
  });

  it.each([0, -1, 1.5, '10', null])('rejects %p with INVALID_MAX_PASSES', (value) => {
    expect(
      parseErrorCode({ ...webhookBase, run_key: [{ json_path: '$.id' }], max_passes: value }),
    ).toBe('INVALID_MAX_PASSES');
  });

  it('rejects max_passes without run_key', () => {
    expect(parseErrorCode({ ...webhookBase, max_passes: 3 })).toBe('INVALID_MAX_PASSES');
  });

  it('rejects max_passes on a slack binding', () => {
    expect(
      parseErrorCode({
        type: 'slack',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
        max_passes: 3,
      }),
    ).toBe('INVALID_MAX_PASSES');
  });
});
