/**
 * Issue #71: `conduit journal inspect` and `conduit journal tail` print a
 * card's harness events beside the existing journal output.
 *
 * Each harness span (`<station>.harness`, `<station>.harness-critic`) is
 * followed by the event rows of the invoke() it reports on, joined by
 * invocation id and printed in seq order. Events of an invocation that has
 * no span (the call is still running, or it never finished) print after the
 * spans, under a line that names the invocation and says `(no span)`. That is how tail
 * follows a live attempt: each run of tail shows the rows written so far,
 * before the span exists. Both commands stay read-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB, type HarnessEventRowInput } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, type CliDeps, type CliIO, type PrereqProbe, type RunEngineArgs } from './main';

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'jc', parent_id: null, lane: 'coder', status: 'working',
    attempt: 0, wave: 0, owned_paths: ['x'], rework_count: 0,
  });
});

afterEach(() => {
  db.close();
});

async function journal(sub: 'inspect' | 'tail'): Promise<string[]> {
  const io = makeIO();
  const deps: CliDeps = {
    io, now: () => 1_000, db, adapter: stubAdapter,
    runEngine: async (_args: RunEngineArgs) => {},
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }] as PrereqProbe[],
  };
  const code = await main(['journal', sub, 'jc'], deps);
  expect(code).toBe(0);
  return io.lines;
}

const AT = Date.UTC(2026, 8, 28, 12, 0, 0);

function event(invocationId: string, seq: number, over: Partial<HarnessEventRowInput> & Pick<HarnessEventRowInput, 'kind'>): HarnessEventRowInput {
  return { runId: DEFAULT_RUN_ID, cardId: 'jc', station: 'coder', attempt: 0, invocationId, seq, atMs: AT + seq, ...over };
}

function span(name: string, invocationId?: string): void {
  db.appendJournalSpan({
    runId: DEFAULT_RUN_ID, cardId: 'jc', station: 'coder', attempt: 0, name,
    ...(invocationId !== undefined ? { invocationId } : {}),
  });
}

/** One maker call, then one critic call, each with its span. */
function seedMakerAndCritic(): void {
  db.appendHarnessEvent(event('inv-maker', 0, { kind: 'lifecycle', phase: 'start' }));
  db.appendHarnessEvent(event('inv-maker', 1, { kind: 'tool-input-available', toolCallId: 't1', toolName: 'Write', path: 'out/a.md' }));
  db.appendHarnessEvent(event('inv-maker', 2, { kind: 'tool-output-available', toolCallId: 't1', isError: true, exitCode: 2 }));
  db.appendHarnessEvent(event('inv-maker', 3, { kind: 'usage', tokens: 120, costUsd: 0.25 }));
  db.appendHarnessEvent(event('inv-maker', 4, { kind: 'lifecycle', phase: 'end', exitCode: 0 }));
  span('coder.harness', 'inv-maker');
  db.appendHarnessEvent(event('inv-critic', 0, { kind: 'lifecycle', phase: 'start' }));
  db.appendHarnessEvent(
    event('inv-critic', 1, {
      kind: 'rate-limit',
      rateLimitStatus: 'allowed_warning',
      rateLimitWindows: [{ name: 'five_hour', utilization: 0.8, resetsAtMs: AT }],
    }),
  );
  span('coder.harness-critic', 'inv-critic');
}

describe('journal inspect prints harness events under their span', () => {
  it('prints each span followed by its own rows in seq order, with the derived columns', async () => {
    seedMakerAndCritic();
    const lines = await journal('inspect');

    const maker = lines.findIndex((l) => l.endsWith(' coder.harness'));
    const critic = lines.findIndex((l) => l.endsWith(' coder.harness-critic'));
    expect(maker).toBeGreaterThanOrEqual(0);
    expect(critic).toBeGreaterThan(maker);

    const makerRows = lines.slice(maker + 1, critic);
    expect(makerRows).toHaveLength(5);
    expect(makerRows[0]).toContain('#0 lifecycle start');
    expect(makerRows[0]).toContain('2026-09-28T12:00:00.000Z');
    expect(makerRows[1]).toContain('#1 tool-input-available Write path=out/a.md');
    expect(makerRows[2]).toContain('#2 tool-output-available error exit=2');
    expect(makerRows[3]).toContain('#3 usage tokens=120');
    expect(makerRows[4]).toContain('#4 lifecycle end exit=0');

    const criticRows = lines.slice(critic + 1, critic + 3);
    expect(criticRows[0]).toContain('#0 lifecycle start');
    expect(criticRows[1]).toContain('#1 rate-limit status=allowed_warning five_hour=80%');
  });

  it('prints spans without an invocation id exactly as before', async () => {
    span('station.start');
    const lines = await journal('inspect');
    expect(lines).toEqual(['[jc] coder@0 station.start']);
  });

  it('is read-only: no state or journal row changes', async () => {
    seedMakerAndCritic();
    const before = db.getCard(DEFAULT_RUN_ID, 'jc');
    const eventsBefore = db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'jc');
    const spansBefore = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'jc');
    await journal('inspect');
    await journal('tail');
    expect(db.getCard(DEFAULT_RUN_ID, 'jc')).toEqual(before);
    expect(db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'jc')).toEqual(eventsBefore);
    expect(db.getJournalSpansForRun(DEFAULT_RUN_ID, 'jc')).toEqual(spansBefore);
  });
});

describe('journal tail follows a live attempt', () => {
  it('shows the rows of a call with no span yet, picks up new rows, then files them under the span', async () => {
    span('coder.harness', 'inv-earlier');
    db.appendHarnessEvent(event('inv-live', 0, { kind: 'lifecycle', phase: 'start' }));
    db.appendHarnessEvent(event('inv-live', 1, { kind: 'tool-input-available', toolCallId: 't1', toolName: 'Read', path: 'src/a.ts' }));

    let lines = await journal('tail');
    const header = lines.findIndex((l) => l.includes('inv-live') && l.includes('(no span)'));
    expect(header).toBeGreaterThan(lines.findIndex((l) => l.endsWith(' coder.harness')));
    expect(lines.slice(header + 1)).toHaveLength(2);
    expect(lines[header + 2]).toContain('#1 tool-input-available Read path=src/a.ts');

    // The call keeps running: tail shows the new row on its next read.
    db.appendHarnessEvent(event('inv-live', 2, { kind: 'tool-output-available', toolCallId: 't1', isError: false }));
    lines = await journal('tail');
    expect(lines.some((l) => l.includes('#2 tool-output-available ok'))).toBe(true);

    // The call returns and its span is written: the rows move under it.
    span('coder.harness', 'inv-live');
    lines = await journal('tail');
    expect(lines.some((l) => l.includes('(no span)'))).toBe(false);
    expect(lines[lines.length - 4]).toMatch(/ coder\.harness$/);
    expect(lines[lines.length - 1]).toContain('#2 tool-output-available ok');
  });

  it('keeps tail to its trailing spans: rows of a span outside the window are not printed', async () => {
    db.appendHarnessEvent(event('inv-old', 0, { kind: 'lifecycle', phase: 'start' }));
    span('coder.harness', 'inv-old');
    for (let i = 0; i < 20; i++) span(`span.${i}`);
    const tailLines = await journal('tail');
    expect(tailLines).toHaveLength(20);
    expect(tailLines.some((l) => l.includes('lifecycle'))).toBe(false);

    const inspectLines = await journal('inspect');
    expect(inspectLines.some((l) => l.includes('#0 lifecycle start'))).toBe(true);
  });

  it('hides the events of a truncated span without mislabeling them (no span), while a truly spanless invocation still gets that label', async () => {
    // inv-old has a span, but that span is pushed out of the tail window below.
    db.appendHarnessEvent(event('inv-old', 0, { kind: 'lifecycle', phase: 'start' }));
    span('coder.harness', 'inv-old');
    for (let i = 0; i < 20; i++) span(`span.${i}`);
    // inv-spanless has no span at all, ever.
    db.appendHarnessEvent(event('inv-spanless', 0, { kind: 'lifecycle', phase: 'start' }));

    const lines = await journal('tail');

    // The truncated span's events are gone, and not relabeled (no span).
    expect(lines.some((l) => l.includes('inv-old'))).toBe(false);
    expect(lines.some((l) => l.includes('#0 lifecycle start') && l.includes('inv-old'))).toBe(false);

    // The genuinely spanless invocation still prints under (no span).
    const header = lines.findIndex((l) => l.includes('inv-spanless') && l.includes('(no span)'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(lines[header + 1]).toContain('#0 lifecycle start');

    // Pinning existing behaviour, not new behaviour: this test is expected to
    // pass immediately (see Fix A / issue #71 review notes).
  });
});
