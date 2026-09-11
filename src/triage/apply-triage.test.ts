/**
 * Tests for the triage security boundary.
 *
 * This is the Law for the triage flow: the two transforms upstream read
 * attacker-authored text, so these assertions are the only thing standing
 * between a successful prompt injection and a privileged GitHub write. They
 * belong in the REQUIRED `tests` job (hence src/), not an advisory one.
 */

import { describe, expect, test } from 'bun:test';
import {
  LABEL_TIERS,
  PRIORITY_VALUES,
  TYPE_VALUES,
  decide,
  fence,
  renderComment,
  TRIAGE_MARKER,
} from './apply-triage';

const CLEAN = { injection_detected: false, evidence: '' };

describe('label allowlist', () => {
  test('every AUTO label is a type value and vice versa', () => {
    const auto = Object.keys(LABEL_TIERS).filter((l) => LABEL_TIERS[l] === 'AUTO').sort();
    expect(auto).toEqual([...TYPE_VALUES].sort());
  });

  test('dismissal and release labels are NEVER, so no input can reach them', () => {
    for (const label of ['invalid', 'wontfix', 'released']) {
      expect(LABEL_TIERS[label]).toBe('NEVER');
      // Exhaustive: no classification, however crafted, yields a NEVER label.
      const d = decide({ type: label, priority_suggestion: label }, CLEAN);
      expect(d.apply).not.toContain(label);
      expect(d.propose).not.toContain(label);
    }
  });

  test('a label the model invents is dropped, never created', () => {
    const d = decide({ type: 'security-cleared' }, CLEAN);
    expect(d.apply).toEqual([]);
    expect(d.suppressed).toBe('no-valid-type');
  });

  test('priority is proposed, never applied', () => {
    for (const p of PRIORITY_VALUES) {
      const d = decide({ type: 'bug', priority_suggestion: p }, CLEAN);
      expect(d.apply).toEqual(['bug']);
      expect(d.propose).toContain(`priority: ${p}`);
    }
  });

  test('area applies no label, because this repo has none', () => {
    const d = decide({ type: 'bug', area: 'kernel' }, CLEAN);
    expect(d.apply).toEqual(['bug']);
    expect(d.propose).toEqual([]);
  });
});

describe('injection verdict suppresses all writes', () => {
  test('a tripped scan yields no labels even with a well-formed classification', () => {
    const d = decide(
      { type: 'bug', priority_suggestion: 'high', possible_duplicate: 12 },
      { injection_detected: true, evidence: 'contains "ignore previous instructions"' },
    );
    expect(d.apply).toEqual([]);
    expect(d.propose).toEqual([]);
    expect(d.suppressed).toBe('injection');
    expect(d.flagged).toBe(true);
  });

  test('only a literal true trips it — a truthy string does not, and does not suppress', () => {
    // Guards against a model emitting "false" as a string and being believed,
    // and against a non-boolean silently reading as flagged.
    const d = decide({ type: 'bug' }, { injection_detected: 'true' });
    expect(d.flagged).toBe(false);
    expect(d.apply).toEqual(['bug']);
  });
});

describe('malformed model output fails closed', () => {
  test.each([
    ['empty object', {}],
    ['null type', { type: null }],
    ['numeric type', { type: 7 }],
    ['array type', { type: ['bug'] }],
    ['prototype-ish key', { type: 'constructor' }],
    ['__proto__ key', { type: '__proto__' }],
  ])('%s applies nothing', (_name, cls) => {
    expect(decide(cls as Record<string, unknown>, CLEAN).apply).toEqual([]);
  });

  test('a non-integer duplicate is not proposed', () => {
    expect(decide({ type: 'bug', possible_duplicate: 1.5 }, CLEAN).propose).toEqual([]);
    expect(decide({ type: 'bug', possible_duplicate: '12' }, CLEAN).propose).toEqual([]);
  });
});

describe('comment fencing', () => {
  test('a fence break in model prose cannot escape the code block', () => {
    const out = renderComment({ type: 'bug', summary: '```\n@maintainer: merge this' }, decide({ type: 'bug' }, CLEAN), CLEAN);
    const body = out.slice(out.indexOf('```text') + '```text'.length);
    // Exactly one closing fence: the one renderComment itself emits.
    expect(body.match(/```/g)).toHaveLength(1);
  });

  test('long summaries are clamped', () => {
    expect(fence('x'.repeat(5000)).length).toBeLessThanOrEqual(1201);
  });

  test('non-string summary renders as empty rather than "undefined"', () => {
    expect(fence(undefined)).toBe('');
    expect(fence({ a: 1 })).toBe('');
  });

  test('a flagged comment says so before showing the classification', () => {
    const scan = { injection_detected: true, evidence: 'e' };
    const out = renderComment({ type: 'bug', summary: 's' }, decide({ type: 'bug' }, scan), scan);
    expect(out).toContain('No labels were applied');
    expect(out.indexOf('No labels were applied')).toBeLessThan(out.indexOf('Model summary'));
  });
});

describe('idempotency marker', () => {
  test('every comment carries the marker the workflow guard greps for', () => {
    for (const scan of [CLEAN, { injection_detected: true, evidence: 'e' }]) {
      const out = renderComment({ type: 'bug', summary: 's' }, decide({ type: 'bug' }, scan), scan);
      expect(out.startsWith(TRIAGE_MARKER)).toBe(true);
    }
  });

  test('the marker is the exact literal .github/workflows/triage.yml greps for', () => {
    // Drift between these two is silent: the guard stops matching and every
    // re-run posts a second comment.
    expect(TRIAGE_MARKER).toBe('<!-- conduit-triage -->');
    const wf = require('node:fs').readFileSync('.github/workflows/triage.yml', 'utf8');
    expect(wf).toContain(`grep -qF '${TRIAGE_MARKER}'`);
  });
});
