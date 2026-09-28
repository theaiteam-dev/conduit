import { describe, it, expect } from 'bun:test';
import { callGateFailClosed, createHarnessToolGate, type HarnessToolGate } from './harness-gate';

const call = { toolName: 'Bash', input: { command: 'echo hi' } };

describe('callGateFailClosed', () => {
  it('passes an allow through', () => {
    expect(callGateFailClosed(() => ({ decision: 'allow' }), call)).toEqual({ decision: 'allow' });
  });

  it('passes a well-formed deny and hold through unchanged', () => {
    const deny = { decision: 'deny', code: 'not_allowlisted', reason: 'rm is not allowlisted' } as const;
    const hold = { decision: 'hold', code: 'needs_human', reason: 'asks a question' } as const;
    expect(callGateFailClosed(() => deny, call)).toEqual(deny);
    expect(callGateFailClosed(() => hold, call)).toEqual(hold);
  });

  it('turns a throw into a gate_error deny', () => {
    const gate: HarnessToolGate = () => {
      throw new Error('boom');
    };
    const out = callGateFailClosed(gate, call);
    expect(out).toMatchObject({ decision: 'deny', code: 'gate_error' });
    expect((out as { reason: string }).reason).toContain('boom');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'allow'],
    ['an unknown decision', { decision: 'maybe' }],
    ['a deny with no code', { decision: 'deny', reason: 'x' }],
    ['a hold with no reason', { decision: 'hold', code: 'needs_human' }],
  ])('turns %s into a gate_error deny', (_label, returned) => {
    const gate = (() => returned) as unknown as HarnessToolGate;
    expect(callGateFailClosed(gate, call)).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });
});

describe('createHarnessToolGate placeholder', () => {
  it('denies every call until the real gate replaces it', () => {
    const gate = createHarnessToolGate({ projectRoot: '/p', tools: ['Read', 'Bash(git:*)'] });
    expect(callGateFailClosed(gate, { toolName: 'Read', input: { file_path: 'a.txt' } })).toMatchObject({
      decision: 'deny',
    });
  });
});
