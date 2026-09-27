/**
 * Tests for ingress run-id derivation (the original ingress-attribution work, FR-1).
 *
 * Contract pinned here:
 *   - deterministic: the same event id always derives the same run id (re-drive
 *     reuses the run, it does not fork a duplicate);
 *   - charset-safe: the derived id always matches validateRunId's
 *     `[A-Za-z0-9_-]{1,128}` regardless of what the provider put in the event id;
 *   - collision-resistant: distinct raw event ids derive distinct run ids even
 *     when sanitization collapses them to the same stem;
 *   - length-bounded: never exceeds 128 chars for arbitrarily long event ids.
 */
import { describe, it, expect } from 'bun:test';
import { deriveIngressRunId, deriveKeyedIngressRunId } from './run-id';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

describe('deriveIngressRunId', () => {
  it('is deterministic for the same event id', () => {
    expect(deriveIngressRunId('Ev06ABC123')).toBe(deriveIngressRunId('Ev06ABC123'));
  });

  it('keeps a readable stem from the event id', () => {
    const runId = deriveIngressRunId('Ev06ABC123');
    expect(runId.startsWith('ig-Ev06ABC123-')).toBe(true);
  });

  it('always matches the CLI run-id charset and length', () => {
    const nasty = [
      'slack:C0123:1720000000.000100',
      'a b c\t\nd',
      '../../etc/passwd',
      'id with "quotes" and $HOME and ;rm -rf /',
      'ünïcödé-évent-😀',
      ':::',
      'x'.repeat(4096),
    ];
    for (const eventId of nasty) {
      const runId = deriveIngressRunId(eventId);
      expect(runId).toMatch(RUN_ID_PATTERN);
    }
  });

  it('derives distinct run ids for distinct event ids that sanitize identically', () => {
    // Both sanitize to 'ev-1' — only the raw-id hash separates them.
    expect(deriveIngressRunId('ev:1')).not.toBe(deriveIngressRunId('ev.1'));
  });

  it('derives distinct run ids for long event ids that share a truncated stem', () => {
    const base = 'z'.repeat(300);
    expect(deriveIngressRunId(`${base}-alpha`)).not.toBe(deriveIngressRunId(`${base}-beta`));
  });

  it('stays within 128 chars for arbitrarily long event ids', () => {
    expect(deriveIngressRunId('e'.repeat(10_000)).length).toBeLessThanOrEqual(128);
  });

  it('produces a valid run id for an event id with no charset-legal characters', () => {
    const runId = deriveIngressRunId('::/::');
    expect(runId).toMatch(RUN_ID_PATTERN);
  });

  it('is prefixed ig- so ingress-derived runs are identifiable', () => {
    expect(deriveIngressRunId('anything').startsWith('ig-')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keyed run ids (issue #36)
// ---------------------------------------------------------------------------

describe('deriveKeyedIngressRunId', () => {
  it('is deterministic for the same flow and key parts', () => {
    expect(deriveKeyedIngressRunId('pr-loop', ['12345', '7'])).toBe(
      deriveKeyedIngressRunId('pr-loop', ['12345', '7']),
    );
  });

  it('carries the igk- prefix and a readable flow stem, inside the run-id budget', () => {
    const runId = deriveKeyedIngressRunId('pr-loop', ['12345', '7']);
    expect(runId.startsWith('igk-pr-loop-')).toBe(true);
    expect(runId).toMatch(RUN_ID_PATTERN);
  });

  it('stays inside the charset and length budget for hostile flow ids and parts', () => {
    const runId = deriveKeyedIngressRunId('flow with spaces/and:colons'.repeat(20), [
      'x'.repeat(10_000),
      '../../etc/passwd',
      '\u0000\n;rm -rf /',
    ]);
    expect(runId).toMatch(RUN_ID_PATTERN);
  });

  it('never embeds key-part text in the run id', () => {
    const runId = deriveKeyedIngressRunId('pr-loop', ['secret-looking-subject']);
    expect(runId).not.toContain('secret-looking-subject');
  });

  it('separates two flows keyed on the same subject', () => {
    expect(deriveKeyedIngressRunId('flow-a', ['1', '2'])).not.toBe(
      deriveKeyedIngressRunId('flow-b', ['1', '2']),
    );
  });

  it('separates flow ids that sanitize to the same stem', () => {
    expect(deriveKeyedIngressRunId('flow:a', ['1'])).not.toBe(deriveKeyedIngressRunId('flow.a', ['1']));
  });

  it('encodes part boundaries unambiguously', () => {
    expect(deriveKeyedIngressRunId('f', ['a-b', 'c'])).not.toBe(deriveKeyedIngressRunId('f', ['a', 'b-c']));
    expect(deriveKeyedIngressRunId('f', ['a', 'b'])).not.toBe(deriveKeyedIngressRunId('f', ['ab']));
    expect(deriveKeyedIngressRunId('f', ['a,b'])).not.toBe(deriveKeyedIngressRunId('f', ['a', 'b']));
    expect(deriveKeyedIngressRunId('f', ['a', 'b'])).not.toBe(deriveKeyedIngressRunId('f', ['b', 'a']));
  });

  it('never collides with a per-delivery run id', () => {
    expect(deriveKeyedIngressRunId('f', ['x']).startsWith('ig-')).toBe(false);
  });
});

describe('deriveIngressRunId is unchanged by keyed derivation', () => {
  it('pins the per-delivery run id for a known event id', () => {
    // A byte-identity pin: an unkeyed binding must keep deriving exactly this.
    expect(deriveIngressRunId('Ev06ABC123')).toBe('ig-Ev06ABC123-52bb6295fee3');
  });
});
