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
import type { StoredHarnessEvent } from '../persistence/db';
import {
  createHarnessEventJournalSink, exitCodeFromToolOutput, formatHarnessEvent, harnessEventRow, pathFromToolInput,
  sanitizeGateReason,
} from './harness-events-journal';

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

  it('stamps at_ms from the injected clock', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      let t = 1_700_000_000_123;
      const sink = createHarnessEventJournalSink(db, SCOPE, () => t++);
      recordFixture(sink);
      const rows = db.getHarnessEventsForRun('r1', 'c1');
      expect(rows[0]!.atMs).toBe(1_700_000_000_123);
      expect(rows.map((r) => r.atMs)).toEqual(rows.map((r) => r.atMs).sort((a, b) => a - b));
    } finally {
      db.close();
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

/** A StoredHarnessEvent with every column null, so a test only sets what it needs. */
function storedEvent(over: Partial<StoredHarnessEvent> & Pick<StoredHarnessEvent, 'kind'>): StoredHarnessEvent {
  return {
    runId: 'r1', cardId: 'c1', station: 'coder', attempt: 0, invocationId: 'inv-a', seq: 0, atMs: 5,
    toolCallId: null, toolName: null, path: null, exitCode: null, isError: null,
    tokens: null, breakdown: null, costUsd: null, rateLimitStatus: null, rateLimitWindows: null, phase: null,
    decision: null, gateCode: null, agentId: null, reason: null,
    ...over,
  };
}

describe('formatHarnessEvent', () => {
  it('renders an ordinary path unchanged', () => {
    const line = formatHarnessEvent(
      storedEvent({ kind: 'tool-input-available', toolName: 'Read', path: 'src/a.ts' }),
    );
    expect(line).toContain('path=src/a.ts');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('escapes a harness-supplied path containing a newline so the row stays one line', () => {
    const line = formatHarnessEvent(
      storedEvent({ kind: 'tool-input-available', toolName: 'Read', path: '\n[card] fake span' }),
    );
    // One physical line: no bare newline made it into the output.
    expect(line.split('\n')).toHaveLength(1);
    // The path is still recoverable, just escaped (JSON.stringify quotes and escapes it).
    expect(line).toContain(`path=${JSON.stringify('\n[card] fake span')}`);
  });

  it('escapes control characters in other harness-supplied fields (toolName, phase, rateLimitStatus, window name)', () => {
    expect(formatHarnessEvent(storedEvent({ kind: 'tool-input-available', toolName: 'Read\nEvil' }))).toContain(
      JSON.stringify('Read\nEvil'),
    );
    expect(formatHarnessEvent(storedEvent({ kind: 'lifecycle', phase: 'end\r\ninjected' }))).toContain(
      JSON.stringify('end\r\ninjected'),
    );
    expect(
      formatHarnessEvent(storedEvent({ kind: 'rate-limit', rateLimitStatus: 'allowed\nwarning' })),
    ).toContain(JSON.stringify('allowed\nwarning'));
    expect(
      formatHarnessEvent(
        storedEvent({
          kind: 'rate-limit',
          rateLimitWindows: [{ name: 'five_hour\nfake', utilization: 0.5, resetsAtMs: 5 }],
        }),
      ),
    ).toContain(JSON.stringify('five_hour\nfake'));
  });
});

describe('gate-decision rows (issue #21)', () => {
  const stamp = { seq: 4, attempt: 1, invocationId: 'inv-g' };

  it('maps an allow to a row with the tool, decision and call id, and no code or reason', () => {
    expect(
      harnessEventRow({ type: 'gate-decision', toolName: 'Read', toolCallId: 'tu-1', decision: 'allow', ...stamp }, SCOPE, 9),
    ).toEqual({
      ...SCOPE, attempt: 1, invocationId: 'inv-g', seq: 4, kind: 'gate-decision', atMs: 9,
      toolCallId: 'tu-1', toolName: 'Read', decision: 'allow',
    });
  });

  it('maps a deny with its code, subagent id and reason', () => {
    const row = harnessEventRow(
      { type: 'gate-decision', toolName: 'Bash', decision: 'deny', code: 'not_allowlisted', reason: 'rm is not allowed', agentId: 'sub-7', ...stamp },
      SCOPE,
      9,
    );
    expect(row).toMatchObject({ decision: 'deny', gateCode: 'not_allowlisted', reason: 'rm is not allowed', agentId: 'sub-7' });
  });

  it('strips control characters from the reason and cuts it to 200 characters', () => {
    const row = harnessEventRow(
      { type: 'gate-decision', toolName: 'Bash', decision: 'deny', code: 'gate_error', reason: `a\nb\x00c\x7fd${'x'.repeat(500)}`, ...stamp },
      SCOPE,
      9,
    );
    expect(row?.reason).toBe(`abcd${'x'.repeat(196)}`);
    expect(row?.reason).toHaveLength(200);
    expect(sanitizeGateReason('line1\r\nline2\u0085')).toBe('line1line2');
  });

  it('round-trips through the journal DB, in order with the other kinds, and keeps no input body', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      const sink = createHarnessEventJournalSink(db, SCOPE, () => 77);
      const { onEvent } = stampHarnessEvents(sink, 2);
      const emit = createHarnessEventEmitter(onEvent);
      emit({ type: 'lifecycle', phase: 'start' });
      emit({ type: 'gate-decision', toolName: 'Bash', toolCallId: 'tu-2', decision: 'hold', code: 'needs_human', reason: 'asks a human', agentId: 'sub-1' });
      const rows = db.getHarnessEventsForRun('r1', 'c1');
      expect(rows.map((r) => r.kind)).toEqual(['lifecycle', 'gate-decision']);
      expect(rows[1]).toMatchObject({
        attempt: 2, seq: 1, toolName: 'Bash', toolCallId: 'tu-2', decision: 'hold', gateCode: 'needs_human',
        reason: 'asks a human', agentId: 'sub-1', atMs: 77,
      });
      expect(rows[0]).toMatchObject({ decision: null, gateCode: null, agentId: null, reason: null });
    } finally {
      db.close();
    }
  });

  it('adds the columns to a journal whose harness_events table predates them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-harness-events-migrate-'));
    const journalPath = join(dir, 'journal.sqlite');
    try {
      const first = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
      first.close();
      // Rebuild the table as the previous release created it: no gate-decision columns.
      const raw = new Database(journalPath);
      raw.exec('DROP TABLE harness_events');
      raw.exec(`CREATE TABLE harness_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, card_id TEXT NOT NULL, station TEXT NOT NULL,
        attempt INTEGER NOT NULL, invocation_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        tool_call_id TEXT, tool_name TEXT, path TEXT, exit_code INTEGER, is_error INTEGER, tokens INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
        cost_usd REAL, rate_limit_status TEXT, rate_limit_windows_json TEXT, phase TEXT, at_ms INTEGER NOT NULL,
        UNIQUE(run_id, card_id, station, attempt, invocation_id, seq))`);
      raw.exec(
        "INSERT INTO harness_events (run_id, card_id, station, attempt, invocation_id, seq, kind, phase, at_ms) VALUES ('r1','c1','coder',0,'old',0,'lifecycle','start',1)",
      );
      raw.close();

      const db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
      try {
        const sink = createHarnessEventJournalSink(db, SCOPE);
        sink({ type: 'gate-decision', toolName: 'Read', decision: 'allow', seq: 0, attempt: 0, invocationId: 'new' });
        const rows = db.getHarnessEventsForRun('r1', 'c1');
        expect(rows.map((r) => [r.invocationId, r.kind, r.decision])).toEqual([
          ['old', 'lifecycle', null],
          ['new', 'gate-decision', 'allow'],
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the decision, tool, code, subagent and reason on one line', () => {
    const line = formatHarnessEvent(
      storedEvent({ kind: 'gate-decision', decision: 'deny', toolName: 'Bash', gateCode: 'not_allowlisted', agentId: 'sub-7', reason: 'rm is not allowed' }),
    );
    expect(line).toContain('gate-decision deny Bash code=not_allowlisted agent=sub-7 reason=rm is not allowed');
    expect(formatHarnessEvent(storedEvent({ kind: 'gate-decision', decision: 'allow', toolName: 'Read' }))).toMatch(/gate-decision allow Read$/);
  });

  it('escapes control characters that reached a stored row from an older writer', () => {
    const line = formatHarnessEvent(storedEvent({ kind: 'gate-decision', decision: 'deny', toolName: 'Bash\nEvil', reason: 'a\nb' }));
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(JSON.stringify('Bash\nEvil'));
  });
});
