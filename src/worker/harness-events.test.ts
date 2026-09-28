/**
 * Harness event stream primitives (issue #70).
 *
 * Pins the two halves of the numbering/stamping split the issue's decisions
 * settled: the ADAPTER numbers `seq` from 0 within one invoke() call and never
 * lets a throwing consumer fail the call (decision 5); the EXECUTOR stamps
 * `attempt` and a per-invoke() `invocationId` (decisions 2 and 3), because two
 * invocations can share an attempt (a rate-limit park, a gated critic).
 */
import { describe, it, expect } from 'bun:test';
import {
  createHarnessEventEmitter,
  stampHarnessEvents,
  type HarnessEvent,
  type StampedHarnessEvent,
} from './harness-events';

describe('createHarnessEventEmitter', () => {
  it('numbers events from 0 in emission order', () => {
    const seen: HarnessEvent[] = [];
    const emit = createHarnessEventEmitter((e) => seen.push(e));

    emit({ type: 'lifecycle', phase: 'start' });
    emit({ type: 'text-delta', id: 'a:0', delta: 'hi' });
    emit({ type: 'lifecycle', phase: 'end', exitCode: 0 });

    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(seen[1]).toEqual({ type: 'text-delta', id: 'a:0', delta: 'hi', seq: 1 });
  });

  it('keeps no state across emitters, so each invoke() call restarts at 0', () => {
    const first: HarnessEvent[] = [];
    const second: HarnessEvent[] = [];
    const a = createHarnessEventEmitter((e) => first.push(e));
    a({ type: 'lifecycle', phase: 'start' });
    a({ type: 'lifecycle', phase: 'end' });
    const b = createHarnessEventEmitter((e) => second.push(e));
    b({ type: 'lifecycle', phase: 'start' });

    expect(second[0]!.seq).toBe(0);
  });

  it('drops an exception from the consumer and keeps numbering', () => {
    const seen: number[] = [];
    let calls = 0;
    const emit = createHarnessEventEmitter((e) => {
      calls += 1;
      if (calls === 1) throw new Error('journal writer exploded');
      seen.push(e.seq);
    });

    expect(() => emit({ type: 'lifecycle', phase: 'start' })).not.toThrow();
    emit({ type: 'lifecycle', phase: 'end' });

    // The dropped event still consumed its seq: a gap is visible to a reader,
    // a silent renumbering would not be.
    expect(seen).toEqual([1]);
  });
});

describe('stampHarnessEvents', () => {
  it('stamps attempt and one invocationId on every event of a call', () => {
    const seen: StampedHarnessEvent[] = [];
    const { invocationId, onEvent } = stampHarnessEvents((e) => seen.push(e), 3);

    onEvent({ type: 'lifecycle', phase: 'start', seq: 0 });
    onEvent({ type: 'lifecycle', phase: 'end', seq: 1 });

    expect(seen).toEqual([
      { type: 'lifecycle', phase: 'start', seq: 0, attempt: 3, invocationId },
      { type: 'lifecycle', phase: 'end', seq: 1, attempt: 3, invocationId },
    ]);
  });

  it('mints a distinct invocationId per call, even under the same attempt', () => {
    const seen: StampedHarnessEvent[] = [];
    const maker = stampHarnessEvents((e) => seen.push(e), 1);
    const critic = stampHarnessEvents((e) => seen.push(e), 1);

    maker.onEvent({ type: 'lifecycle', phase: 'start', seq: 0 });
    critic.onEvent({ type: 'lifecycle', phase: 'start', seq: 0 });

    expect(maker.invocationId).not.toBe(critic.invocationId);
    // A UUID, so a kernel restart cannot reissue one a journal already holds.
    expect(maker.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seen.map((e) => e.invocationId)).toEqual([maker.invocationId, critic.invocationId]);
    expect(seen.map((e) => e.attempt)).toEqual([1, 1]);
  });
});
