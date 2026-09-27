/**
 * claude-headless adapter: the onEvent sink (issue #70).
 *
 * The runner seam is faked the way harness-adapter-claude.test.ts fakes it,
 * with one addition: this fake plays the recorded stream through the runner
 * config's `onStdoutLine` and `stdoutLineFilter` exactly as runHarnessProcess
 * does, so the test sees what a consumer would see from a real spawn, and the
 * adapter's own result parsing still reads only the kept lines.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createClaudeHarnessAdapter } from './harness-adapter-claude';
import { mapClaudeStreamLine } from './harness-events-claude';
import type { HarnessEvent } from './harness-events';
import type { HarnessInvocation, KnownUsage } from './harness-adapter';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from './harness-runner';

const FIXTURE_LINES = readFileSync(
  join(import.meta.dir, '..', '..', 'fixtures', 'harness', 'claude-stream-json.ndjson'),
  'utf8',
)
  .split('\n')
  .filter((l) => l.length > 0);

interface PlayedRun {
  run: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  /** The retained stdout the adapter was handed back, per call. */
  kept: string[];
}

/** A runner that streams `lines` through the config's line hooks, as the real runner does. */
function playLines(lines: string[], spawn: Partial<HarnessSpawnResult> = {}): PlayedRun {
  const kept: string[] = [];
  const run = async (_cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
    const retained: string[] = [];
    for (const l of lines) {
      config.onStdoutLine?.(l);
      if (config.stdoutLineFilter === undefined || config.stdoutLineFilter(l)) retained.push(l);
    }
    const stdout = retained.join('\n');
    kept.push(stdout);
    return { exitCode: 0, stderr: '', durationMs: 10, timedOut: false, idledOut: false, stdout, ...spawn };
  };
  return { run, kept };
}

function makeAdapter(run: PlayedRun['run']) {
  return createClaudeHarnessAdapter({ projectRoot: '/work/project', envAllowlist: ['PATH'], run });
}

function invocation(over: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do it', inputs: [], tools: ['Bash', 'Write'], timeoutMs: 60_000, ...over };
}

/** Strip `seq` so an event can be compared with the mapper's own output. */
const body = ({ seq: _seq, ...rest }: HarnessEvent) => rest;

describe('claude-headless onEvent: the recorded run', () => {
  it('delivers every mapped event between a lifecycle start and end, numbered from 0', async () => {
    const events: HarnessEvent[] = [];
    const adapter = makeAdapter(playLines(FIXTURE_LINES).run);

    await adapter.invoke(invocation({ onEvent: (e) => events.push(e) }));

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events[0]).toEqual({ type: 'lifecycle', phase: 'start', seq: 0 });
    expect(events.at(-1)).toEqual({ type: 'lifecycle', phase: 'end', exitCode: 0, seq: events.length - 1 });
    expect(events.slice(1, -1).map(body)).toEqual(FIXTURE_LINES.flatMap(mapClaudeStreamLine));
    // Every class the recorded run can produce arrived.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        'lifecycle', 'reasoning-delta', 'text-delta', 'tool-input-start', 'tool-input-available',
        'tool-output-available', 'rate-limit', 'usage',
      ]),
    );
  });

  it('still retains only the result and rate_limit_event lines', async () => {
    const played = playLines(FIXTURE_LINES);
    await makeAdapter(played.run).invoke(invocation({ onEvent: () => {} }));

    const types = played.kept[0]!.split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(['rate_limit_event', 'result']);
  });

  it('returns the same result with or without a sink', async () => {
    const withSink = await makeAdapter(playLines(FIXTURE_LINES).run).invoke(invocation({ onEvent: () => {} }));
    const without = await makeAdapter(playLines(FIXTURE_LINES).run).invoke(invocation());

    expect(withSink).toEqual(without);
    expect((withSink.usage as KnownUsage).tokens).toBe(26 + 720 + 58272 + 8919);
  });

  it('keeps firing onProgress per line beside the events', async () => {
    let progress = 0;
    await makeAdapter(playLines(FIXTURE_LINES).run).invoke(
      invocation({ onEvent: () => {}, onProgress: () => { progress += 1; } }),
    );
    expect(progress).toBe(FIXTURE_LINES.length);
  });
});

describe('claude-headless onEvent: a throwing consumer', () => {
  it('cannot fail the call, and later events still arrive', async () => {
    const seqs: number[] = [];
    const adapter = makeAdapter(playLines(FIXTURE_LINES).run);

    const result = await adapter.invoke(
      invocation({
        onEvent: (e) => {
          seqs.push(e.seq);
          throw new Error('journal writer threw');
        },
      }),
    );

    expect((result.usage as KnownUsage).cost).toBe(0.0272912);
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs.at(-1)).toBe(seqs.length - 1);
  });
});

describe('claude-headless onEvent: how the call ended', () => {
  const partial = FIXTURE_LINES.slice(0, 8);

  it('closes with lifecycle timeout when the wall-clock bound killed the process', async () => {
    const events: HarnessEvent[] = [];
    const adapter = makeAdapter(playLines(partial, { timedOut: true, exitCode: 143 }).run);

    await expect(adapter.invoke(invocation({ onEvent: (e) => events.push(e) }))).rejects.toMatchObject({
      code: 'harness-timeout',
    });
    expect(events[0]!.type).toBe('lifecycle');
    expect(body(events.at(-1)!)).toEqual({ type: 'lifecycle', phase: 'timeout' });
    expect(events.filter((e) => e.type === 'lifecycle')).toHaveLength(2);
  });

  it('closes with lifecycle idle-timeout when the idle bound killed the process', async () => {
    const events: HarnessEvent[] = [];
    const adapter = makeAdapter(playLines(partial, { idledOut: true, exitCode: 143 }).run);

    await expect(
      adapter.invoke(invocation({ idleTimeoutMs: 1000, onEvent: (e) => events.push(e) })),
    ).rejects.toMatchObject({ code: 'harness-idle-timeout' });
    expect(body(events.at(-1)!)).toEqual({ type: 'lifecycle', phase: 'idle-timeout' });
    expect(events.filter((e) => e.type === 'lifecycle')).toHaveLength(2);
  });

  it('reports the exit code on end when the process exited nonzero', async () => {
    const events: HarnessEvent[] = [];
    const adapter = makeAdapter(playLines(partial, { exitCode: 1, stderr: 'boom' }).run);

    await expect(adapter.invoke(invocation({ onEvent: (e) => events.push(e) }))).rejects.toMatchObject({
      code: 'harness-nonzero-exit',
    });
    expect(body(events.at(-1)!)).toEqual({ type: 'lifecycle', phase: 'end', exitCode: 1 });
  });

  it('still closes the bracket when the runner itself throws', async () => {
    const events: HarnessEvent[] = [];
    const adapter = makeAdapter(async () => {
      throw new Error('spawn failed');
    });

    await expect(adapter.invoke(invocation({ onEvent: (e) => events.push(e) }))).rejects.toThrow('spawn failed');
    expect(events.map(body)).toEqual([
      { type: 'lifecycle', phase: 'start' },
      { type: 'lifecycle', phase: 'end' },
    ]);
  });
});
