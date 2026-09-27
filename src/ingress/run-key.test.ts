/**
 * Tests for run-key resolution and the webhook event filter (issue #36).
 *
 * resolveRunKey turns a binding's `run_key` parts into ordered string values
 * from one event. Only scalars count: an object, array, null, missing path, or
 * empty string leaves the part unresolved, and ANY unresolved part rejects the
 * whole key (fail closed, no content-hash fallback). A json_path part with
 * alternatives takes the first alternative that resolves.
 *
 * matchesWhen evaluates a binding's `when` conditions (ANDed) against the
 * same event, comparing resolved scalars as strings.
 */
import { describe, it, expect } from 'bun:test';
import { resolveRunKey, matchesWhen, MAX_RUN_KEY_PART_LENGTH } from './run-key';

const prEvent = {
  headers: { 'X-GitHub-Event': 'pull_request_review', 'X-GitHub-Hook-ID': '991' },
  body: {
    action: 'submitted',
    repository: { id: 12345, full_name: 'acme/widgets' },
    pull_request: { number: 7, draft: false },
    labels: ['bug'],
    nothing: null,
  },
};

describe('resolveRunKey', () => {
  it('resolves json_path and header parts in declared order, stringifying scalars', () => {
    const result = resolveRunKey(
      [{ json_path: ['$.repository.id'] }, { json_path: ['$.pull_request.number'] }, { header: 'x-github-hook-id' }],
      prEvent,
    );
    expect(result).toEqual({ ok: true, parts: ['12345', '7', '991'] });
  });

  it('matches headers case-insensitively', () => {
    const result = resolveRunKey([{ header: 'X-GITHUB-EVENT' }], prEvent);
    expect(result).toEqual({ ok: true, parts: ['pull_request_review'] });
  });

  it('takes the first alternative that resolves', () => {
    const issueComment = { headers: {}, body: { repository: { id: 1 }, issue: { number: 99 } } };
    const result = resolveRunKey(
      [{ json_path: ['$.repository.id'] }, { json_path: ['$.pull_request.number', '$.issue.number'] }],
      issueComment,
    );
    expect(result).toEqual({ ok: true, parts: ['1', '99'] });
  });

  it('prefers an earlier alternative when several resolve', () => {
    const both = { headers: {}, body: { pull_request: { number: 7 }, issue: { number: 99 } } };
    expect(resolveRunKey([{ json_path: ['$.pull_request.number', '$.issue.number'] }], both)).toEqual({
      ok: true,
      parts: ['7'],
    });
  });

  it('stringifies booleans', () => {
    expect(resolveRunKey([{ json_path: ['$.pull_request.draft'] }], prEvent)).toEqual({
      ok: true,
      parts: ['false'],
    });
  });

  it.each([
    ['a missing path', '$.pull_request.missing'],
    ['an object', '$.repository'],
    ['an array', '$.labels'],
    ['a null', '$.nothing'],
  ])('rejects %s as unresolved', (_label, path) => {
    const result = resolveRunKey([{ json_path: ['$.repository.id'] }, { json_path: [path] }], prEvent);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('part 1');
  });

  it('rejects when no alternative resolves', () => {
    const result = resolveRunKey([{ json_path: ['$.a', '$.b'] }], prEvent);
    expect(result.ok).toBe(false);
  });

  it('rejects an absent header', () => {
    expect(resolveRunKey([{ header: 'x-missing' }], prEvent).ok).toBe(false);
  });

  it('rejects an empty-string value', () => {
    expect(resolveRunKey([{ header: 'x-empty' }], { headers: { 'x-empty': '' }, body: {} }).ok).toBe(false);
  });

  it('rejects a part longer than the bound rather than embedding unbounded text', () => {
    const long = { headers: {}, body: { id: 'x'.repeat(MAX_RUN_KEY_PART_LENGTH + 1) } };
    const result = resolveRunKey([{ json_path: ['$.id'] }], long);
    expect(result.ok).toBe(false);
    const atBound = { headers: {}, body: { id: 'x'.repeat(MAX_RUN_KEY_PART_LENGTH) } };
    expect(resolveRunKey([{ json_path: ['$.id'] }], atBound).ok).toBe(true);
  });

  it('falls through an over-length alternative to a later, short one instead of rejecting the whole key', () => {
    const event = {
      headers: {},
      body: { long: 'x'.repeat(MAX_RUN_KEY_PART_LENGTH + 1), short: 'ok' },
    };
    const result = resolveRunKey([{ json_path: ['$.long', '$.short'] }], event);
    expect(result).toEqual({ ok: true, parts: ['ok'] });
  });

  it('reports the over-length reason when every alternative is over-length', () => {
    const event = {
      headers: {},
      body: { a: 'x'.repeat(MAX_RUN_KEY_PART_LENGTH + 1), b: 'y'.repeat(MAX_RUN_KEY_PART_LENGTH + 2) },
    };
    const result = resolveRunKey([{ json_path: ['$.a', '$.b'] }], event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('part 0');
    expect(result.reason).toContain(`over the ${MAX_RUN_KEY_PART_LENGTH}-char limit`);
  });

  it('rejects a non-object body without throwing', () => {
    expect(resolveRunKey([{ json_path: ['$.id'] }], { headers: {}, body: 'plain text' }).ok).toBe(false);
  });
});

describe('matchesWhen', () => {
  it('matches when every condition holds (AND)', () => {
    expect(
      matchesWhen(
        [
          { header: 'x-github-event', in: ['pull_request_review', 'issue_comment'] },
          { json_path: '$.action', not_in: ['deleted', 'edited'] },
          { json_path: '$.pull_request.number', present: true },
        ],
        prEvent,
      ),
    ).toBe(true);
  });

  it('fails when any one condition fails', () => {
    expect(
      matchesWhen(
        [
          { header: 'x-github-event', in: ['pull_request_review'] },
          { json_path: '$.action', in: ['created'] },
        ],
        prEvent,
      ),
    ).toBe(false);
  });

  it('compares numbers and booleans as strings', () => {
    expect(matchesWhen([{ json_path: '$.repository.id', in: ['12345'] }], prEvent)).toBe(true);
    expect(matchesWhen([{ json_path: '$.pull_request.draft', in: ['false'] }], prEvent)).toBe(true);
  });

  it('treats an unresolved subject as not in any list: in fails, not_in holds', () => {
    expect(matchesWhen([{ json_path: '$.missing', in: ['x'] }], prEvent)).toBe(false);
    expect(matchesWhen([{ json_path: '$.missing', not_in: ['x'] }], prEvent)).toBe(true);
  });

  it('treats a non-scalar value as unresolved for in and not_in', () => {
    expect(matchesWhen([{ json_path: '$.repository', in: ['[object Object]'] }], prEvent)).toBe(false);
    expect(matchesWhen([{ json_path: '$.labels', not_in: ['bug'] }], prEvent)).toBe(true);
  });

  it('reads present as "exists and is not null", whatever the type', () => {
    expect(matchesWhen([{ json_path: '$.repository', present: true }], prEvent)).toBe(true);
    expect(matchesWhen([{ json_path: '$.labels', present: true }], prEvent)).toBe(true);
    expect(matchesWhen([{ json_path: '$.pull_request.draft', present: true }], prEvent)).toBe(true);
    expect(matchesWhen([{ json_path: '$.nothing', present: true }], prEvent)).toBe(false);
    expect(matchesWhen([{ json_path: '$.nothing', present: false }], prEvent)).toBe(true);
    expect(matchesWhen([{ json_path: '$.missing', present: false }], prEvent)).toBe(true);
  });

  it('tells a GitHub issue_comment on a pull request from one on a plain issue', () => {
    // GitHub marks a PR conversation comment with an OBJECT at issue.pull_request.
    const onPr = {
      headers: { 'X-GitHub-Event': 'issue_comment' },
      body: {
        action: 'created',
        issue: {
          number: 42,
          pull_request: {
            url: 'https://api.github.com/repos/acme/widgets/pulls/42',
            html_url: 'https://github.com/acme/widgets/pull/42',
            merged_at: null,
          },
        },
        comment: { id: 9001, body: 'nit: rename this' },
        repository: { id: 12345 },
      },
    };
    const onIssue = {
      headers: { 'X-GitHub-Event': 'issue_comment' },
      body: {
        action: 'created',
        issue: { number: 43 },
        comment: { id: 9002, body: 'same here' },
        repository: { id: 12345 },
      },
    };
    const when = [
      { header: 'X-GitHub-Event', in: ['issue_comment'] },
      { json_path: '$.issue.pull_request', present: true },
    ];
    expect(matchesWhen(when, onPr)).toBe(true);
    expect(matchesWhen(when, onIssue)).toBe(false);
  });

  it('evaluates present on headers', () => {
    expect(matchesWhen([{ header: 'X-GitHub-Event', present: true }], prEvent)).toBe(true);
    expect(matchesWhen([{ header: 'x-missing', present: false }], prEvent)).toBe(true);
    expect(matchesWhen([{ header: 'x-missing', present: true }], prEvent)).toBe(false);
  });
});
