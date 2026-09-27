/**
 * Harness event stream (issue #70).
 *
 * A Conduit-owned, harness-neutral vocabulary for what a `kind: harness`
 * invocation does while it runs. The first five kinds are a vendored subset of
 * the AI SDK's `UIMessageChunk` shapes (`text-delta`, `reasoning-delta`,
 * `tool-input-start`, `tool-input-available`, `tool-output-available`), so a
 * later encoder can hand them to `useChat` without translation. Conduit takes
 * the vocabulary, not the dependency: nothing here imports `ai` or `@ai-sdk/*`.
 * `usage`, `rate-limit` and `lifecycle` are Conduit's own.
 *
 * Numbering and stamping are split between two owners (the #70 decisions):
 *   - The ADAPTER numbers `seq` from 0 within one `invoke()` call and holds no
 *     state across calls (createHarnessEventEmitter).
 *   - The EXECUTOR stamps `attempt` and an `invocationId` minted per `invoke()`
 *     call (stampHarnessEvents). Two invocations can share an attempt (a
 *     rate-limit park re-invokes without consuming one; a gated station's
 *     critic runs under the maker's attempt), so the invocation, not the
 *     attempt, is the key. Order within a call is `seq`; across calls, time.
 */

import { randomUUID } from 'node:crypto';
import type { RateLimitWindow, UsageBreakdown } from './harness-adapter';

/** One event as a mapper or adapter produces it, before it is numbered. */
export type HarnessEventBody =
  /** One whole assistant text block (no partial messages, so one per block). */
  | { type: 'text-delta'; id: string; delta: string }
  /** One whole thinking block. The CLI may redact its text to ''. */
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-output-available';
      toolCallId: string;
      /** The tool_result content as the harness reported it (string or blocks). */
      output: unknown;
      /** Conduit extension: the harness flagged the result as an error. */
      isError: boolean;
      /**
       * Conduit extension: the harness's raw structured tool result, when it
       * sent one. Not parsed: a Bash result carries no clean exit code.
       */
      toolUseResult?: unknown;
    }
  | {
      type: 'usage';
      /** Total across every class, the same figure KnownUsage.tokens carries. */
      tokens: number;
      breakdown: UsageBreakdown;
      costUsd?: number;
    }
  | { type: 'rate-limit'; status?: string; usingOverage?: boolean; windows: RateLimitWindow[] }
  | {
      type: 'lifecycle';
      /**
       * `start` precedes the spawn; exactly one of the other three closes the
       * call. `end` covers every exit that was not a timeout kill, including a
       * nonzero exit and a runner that threw before reporting one.
       */
      phase: 'start' | 'end' | 'timeout' | 'idle-timeout';
      /** On `end`, when the process reported one. */
      exitCode?: number;
    };

/** An event as an adapter delivers it: numbered within its `invoke()` call. */
export type HarnessEvent = HarnessEventBody & { seq: number };

/** An event after the executor's wrapper has said which call produced it. */
export type HarnessEventStamp = { attempt: number; invocationId: string };
export type StampedHarnessEvent = HarnessEvent & HarnessEventStamp;

export type HarnessEventSink = (event: HarnessEvent) => void;

/**
 * The adapter's side: returns an `emit` that numbers each event and hands it
 * to `onEvent`. Create one per `invoke()` call.
 *
 * A throw from the consumer is caught and dropped. A billed harness call must
 * not fail because a journal writer threw, and the runner calls this from its
 * stdout drain, where a throw would reject the whole spawn. The dropped event
 * keeps its `seq`, so the gap is visible to whoever reads the rest.
 */
export function createHarnessEventEmitter(onEvent: HarnessEventSink): (body: HarnessEventBody) => void {
  let seq = 0;
  return (body) => {
    const event = { ...body, seq: seq++ } as HarnessEvent;
    try {
      onEvent(event);
    } catch {
      // Dropped by design (see above).
    }
  };
}

/**
 * The executor's side: wraps `sink` so every event of ONE `invoke()` call is
 * stamped with `attempt` and a freshly minted `invocationId`. Call it once per
 * `invoke()`, maker and critic alike, and pass `onEvent` on the invocation.
 * `invocationId` is returned so the call's journal span can carry it too.
 */
export function stampHarnessEvents(
  sink: (event: StampedHarnessEvent) => void,
  attempt: number,
): { invocationId: string; onEvent: HarnessEventSink } {
  const invocationId = randomUUID();
  return {
    invocationId,
    onEvent: (event) => sink({ ...event, attempt, invocationId }),
  };
}
