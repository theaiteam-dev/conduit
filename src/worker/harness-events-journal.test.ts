/**
 * Issue #71: the harness event journal writer.
 *
 * Drives the REAL recorded stream-json fixture from #70 through the mapper,
 * the executor's stamp (stampHarnessEvents) and the journal sink into a real
 * journal DB, then reads the rows back. What must hold:
 *   - only the five durable kinds are written; text, reasoning and
 *     tool-input-start deltas are dropped;
 *   - no tool output body and no tool input body reaches any column;
 *   - a failed Bash call's exit code is parsed from its error string, a clean
 *     one stays NULL; a Write's path comes from its input and its result.
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB } from '../persistence/db';
import { mapClaudeStreamLine } from './harness-events-claude';
import { createHarnessEventEmitter, stampHarnessEvents, type StampedHarnessEvent } from './harness-events';
import { createHarnessEventJournalSink, exitCodeFromToolOutput, harnessEventRow, pathFromToolInput } from './harness-events-journal';

const FIXTURE = join(import.meta.dir, '..', '..', 'fixtures', 'harness', 'claude-stream-json.ndjson');
const fixtureLines = (): string[] => readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.length > 0);

const SCOPE = { runId: 'r1', cardId: 'c1', station: 'coder' } as const;

/** Feed the fixture through emitter -> stamp -> sink, as the adapter and executor do. */
function recordFixture(sink: (e: StampedHarnessEvent) => void): string {
  const { invocationId, onEvent } = stampHarnessEvents(sink, 0);
  const emit = createHarnessEventEmitter(onEvent);
  emit({ type: 'lifecycle', phase: 'start' });
  for (const l of fixtureLines()) for (const body of mapClaudeStreamLine(l)) emit(body);
  emit({ type: 'lifecycle', phase: 'end', exitCode: 0 });
  return invocationId;
}

describe('createHarnessEventJournalSink over the recorded run', () => {
  it('writes only the durable kinds, in seq order, under one invocation id', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      const invocationId = recordFixture(createHarnessEventJournalSink(db, SCOPE));
      const rows = db.getHarnessEventsForRun('r1', 'c1');

      expect(rows.map((r) => r.kind)).toEqual([
        'lifecycle',
        'tool-input-available', 'tool-output-available',
        'tool-input-available', 'tool-output-available',
        'rate-limit',
        'tool-input-available', 'tool-output-available',
        'usage',
        'lifecycle',
      ]);
      // seq keeps the adapter's numbering, gaps where deltas were dropped.
      const seqs = rows.map((r) => r.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(seqs[0]).toBe(0);
      expect(new Set(rows.map((r) => r.invocationId))).toEqual(new Set([invocationId]));
      expect(rows.every((r) => r.attempt === 0 && r.station === 'coder')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('derives tool name, path, is_error and exit code, and carries usage and rate-limit figures', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      recordFixture(createHarnessEventJournalSink(db, SCOPE));
      const rows = db.getHarnessEventsForRun('r1', 'c1');
      const inputs = rows.filter((r) => r.kind === 'tool-input-available');
      const outputs = rows.filter((r) => r.kind === 'tool-output-available');

      expect(inputs.map((r) => [r.toolName, r.path])).toEqual([
        ['Bash', null],
        ['Bash', null],
        ['Write', '/work/project/notes.txt'],
      ]);
      expect(outputs.map((r) => r.toolCallId)).toEqual(inputs.map((r) => r.toolCallId));
      expect(outputs.map((r) => [r.isError, r.exitCode, r.path])).toEqual([
        [false, null, null],
        [true, 2, null],
        [false, null, '/work/project/notes.txt'],
      ]);

      const usage = rows.find((r) => r.kind === 'usage')!;
      expect(usage.tokens).toBeGreaterThan(0);
      expect(usage.breakdown).not.toBeNull();

      const rateLimit = rows.find((r) => r.kind === 'rate-limit')!;
      expect(rateLimit.rateLimitWindows!.length).toBeGreaterThan(0);
      expect(typeof rateLimit.rateLimitWindows![0]!.utilization).toBe('number');

      const end = rows[rows.length - 1]!;
      expect([end.phase, end.exitCode]).toEqual(['end', 0]);
    } finally {
      db.close();
    }
  });

  it('never stores a tool output body, a tool input body, or assistant text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-harness-events-bodies-'));
    const journalPath = join(dir, 'journal.sqlite');
    try {
      const db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
      recordFixture(createHarnessEventJournalSink(db, SCOPE));
      db.close();

      // Dump every column of every row as text, straight from the file.
      const raw = new Database(journalPath, { readonly: true });
      const dump = JSON.stringify(raw.prepare('SELECT * FROM harness_events').all());
      raw.close();

      expect(dump).toContain('notes.txt'); // the path is kept
      for (const body of [
        'hello-conduit', // Bash stdout, and the command that printed it
        'does-not-exist', // the failed Bash call's output and its command
        'No such file or directory',
        '"recorded"', // the Write call's content
        'recorded"',
      ]) {
        expect(dump).not.toContain(body);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows a journal write failure so the harness call cannot fail on it', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const sink = createHarnessEventJournalSink(db, SCOPE);
    db.close();
    expect(() =>
      sink({ type: 'lifecycle', phase: 'start', seq: 0, attempt: 0, invocationId: 'inv' }),
    ).not.toThrow();
  });
});

describe('harnessEventRow', () => {
  const stamp = { seq: 3, attempt: 1, invocationId: 'inv-x' };

  it('returns null for every delta kind', () => {
    expect(harnessEventRow({ type: 'text-delta', id: 't', delta: 'hi', ...stamp }, SCOPE, 5)).toBeNull();
    expect(harnessEventRow({ type: 'reasoning-delta', id: 't', delta: 'hm', ...stamp }, SCOPE, 5)).toBeNull();
    expect(harnessEventRow({ type: 'tool-input-start', toolCallId: 't', toolName: 'Bash', ...stamp }, SCOPE, 5)).toBeNull();
  });

  it('stamps scope, attempt, invocation id, seq and the receive time', () => {
    expect(harnessEventRow({ type: 'lifecycle', phase: 'timeout', ...stamp }, SCOPE, 5)).toEqual({
      ...SCOPE, attempt: 1, invocationId: 'inv-x', seq: 3, kind: 'lifecycle', phase: 'timeout', atMs: 5,
    });
  });
});

describe('pathFromToolInput', () => {
  it('reads file_path, notebook_path or path, and nothing else', () => {
    expect(pathFromToolInput({ file_path: '/a', content: 'x' })).toBe('/a');
    expect(pathFromToolInput({ notebook_path: '/n.ipynb' })).toBe('/n.ipynb');
    expect(pathFromToolInput({ pattern: '*.ts', path: 'src' })).toBe('src');
    expect(pathFromToolInput({ command: 'cat /etc/passwd' })).toBeUndefined();
    expect(pathFromToolInput({ file_path: 42 })).toBeUndefined();
    expect(pathFromToolInput('not an object')).toBeUndefined();
  });
});

describe('exitCodeFromToolOutput', () => {
  it('parses the Bash failure prefix from tool_use_result or the result content', () => {
    expect(exitCodeFromToolOutput(true, 'Error: Exit code 2\nls: nope', undefined)).toBe(2);
    expect(exitCodeFromToolOutput(true, undefined, 'Exit code 127\nsh: x: not found')).toBe(127);
    expect(exitCodeFromToolOutput(true, undefined, [{ type: 'text', text: 'Exit code 1' }])).toBe(1);
  });

  it('is undefined for a clean call or an error that names no exit code', () => {
    expect(exitCodeFromToolOutput(false, { stdout: 'Exit code 9' }, 'Exit code 9')).toBeUndefined();
    expect(exitCodeFromToolOutput(true, 'Error: file not found', 'File does not exist.')).toBeUndefined();
  });
});
