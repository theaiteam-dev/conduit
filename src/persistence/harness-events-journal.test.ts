/**
 * Issue #71: durable harness events in the journal DB.
 *
 * `harness_events` holds one row per durable event of one harness `invoke()`
 * call, keyed (run, card, station, attempt, invocation_id, seq). Harness
 * spans gain an `invocation_id` column so the rows join to the span of the
 * call that produced them. Both are additive: a journal written before this
 * change opens, keeps its rows, and reads their invocation id back as NULL.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, type HarnessEventRowInput } from './db';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-events-journal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE = { runId: 'r1', cardId: 'c1', station: 'coder', attempt: 0, invocationId: 'inv-a' } as const;

function row(over: Partial<HarnessEventRowInput> & Pick<HarnessEventRowInput, 'seq' | 'kind'>): HarnessEventRowInput {
  return { ...BASE, atMs: 1_000 + over.seq, ...over };
}

function memDb(): ConduitDB {
  return openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
}

describe('harness_events on a fresh journal', () => {
  it('round-trips every column and reads rows back in insertion order', () => {
    const db = memDb();
    try {
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
      db.appendHarnessEvent(row({ seq: 1, kind: 'tool-input-available', toolCallId: 't1', toolName: 'Write', path: 'out/a.md' }));
      db.appendHarnessEvent(row({ seq: 2, kind: 'tool-output-available', toolCallId: 't1', isError: true, exitCode: 2 }));
      db.appendHarnessEvent(
        row({
          seq: 3,
          kind: 'usage',
          tokens: 120,
          breakdown: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 60, cacheCreationInputTokens: 30 },
          costUsd: 0.25,
        }),
      );
      db.appendHarnessEvent(
        row({
          seq: 4,
          kind: 'rate-limit',
          rateLimitStatus: 'allowed_warning',
          rateLimitWindows: [{ name: 'five_hour', utilization: 0.8, resetsAtMs: 9_000 }],
        }),
      );
      db.appendHarnessEvent(row({ seq: 5, kind: 'lifecycle', phase: 'end', exitCode: 0 }));

      const rows = db.getHarnessEventsForRun('r1', 'c1');
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(rows[0]).toMatchObject({ ...BASE, kind: 'lifecycle', phase: 'start', exitCode: null, atMs: 1_000 });
      expect(rows[1]).toMatchObject({ kind: 'tool-input-available', toolCallId: 't1', toolName: 'Write', path: 'out/a.md', isError: null });
      expect(rows[2]).toMatchObject({ kind: 'tool-output-available', toolCallId: 't1', isError: true, exitCode: 2, path: null });
      expect(rows[3]).toMatchObject({
        kind: 'usage',
        tokens: 120,
        breakdown: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 60, cacheCreationInputTokens: 30 },
        costUsd: 0.25,
      });
      expect(rows[4]).toMatchObject({
        kind: 'rate-limit',
        rateLimitStatus: 'allowed_warning',
        rateLimitWindows: [{ name: 'five_hour', utilization: 0.8, resetsAtMs: 9_000 }],
      });
      expect(rows[5]).toMatchObject({ kind: 'lifecycle', phase: 'end', exitCode: 0 });
    } finally {
      db.close();
    }
  });

  it('scopes reads to (run, card)', () => {
    const db = memDb();
    try {
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
      db.appendHarnessEvent({ ...row({ seq: 0, kind: 'lifecycle', phase: 'start' }), runId: 'r2' });
      db.appendHarnessEvent({ ...row({ seq: 0, kind: 'lifecycle', phase: 'start' }), cardId: 'c2' });
      expect(db.getHarnessEventsForRun('r1', 'c1')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('keys on invocation_id: two invocations under one attempt both keep seq 0, a replay of the same key is ignored', () => {
    const db = memDb();
    try {
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
      db.appendHarnessEvent({ ...row({ seq: 0, kind: 'lifecycle', phase: 'start' }), invocationId: 'inv-b' });
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'end' }));
      const rows = db.getHarnessEventsForRun('r1', 'c1');
      expect(rows.map((r) => [r.invocationId, r.phase])).toEqual([
        ['inv-a', 'start'],
        ['inv-b', 'start'],
      ]);
    } finally {
      db.close();
    }
  });

  it('deleteRun removes the run\'s harness events and keeps other runs\'', () => {
    const db = memDb();
    try {
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
      db.appendHarnessEvent({ ...row({ seq: 0, kind: 'lifecycle', phase: 'start' }), runId: 'r2' });
      db.deleteRun('r1');
      expect(db.getHarnessEventsForRun('r1', 'c1')).toHaveLength(0);
      expect(db.getHarnessEventsForRun('r2', 'c1')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('prepares its INSERT once and reuses it across events (events arrive per stdout line)', () => {
    const prepareSpy = spyOn(Database.prototype, 'prepare');
    const db = memDb();
    try {
      const before = prepareSpy.mock.calls.length;
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
      db.appendHarnessEvent(row({ seq: 1, kind: 'lifecycle', phase: 'end' }));
      db.appendHarnessEvent({ ...row({ seq: 2, kind: 'lifecycle', phase: 'end' }), invocationId: 'inv-b' });
      const insertCalls = prepareSpy.mock.calls
        .slice(before)
        .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO harness_events'));
      expect(insertCalls).toHaveLength(1);
      expect(db.getHarnessEventsForRun('r1', 'c1')).toHaveLength(3);
    } finally {
      prepareSpy.mockRestore();
      db.close();
    }
  });
});

describe('journal span invocation_id', () => {
  it('round-trips through appendJournalSpan and both span readers, NULL when unset', () => {
    const db = memDb();
    try {
      db.appendJournalSpan({ runId: 'r1', cardId: 'c1', station: 'coder', attempt: 0, name: 'coder.harness', invocationId: 'inv-a' });
      db.appendJournalSpan({ runId: 'r1', cardId: 'c1', station: 'coder', attempt: 0, name: 'station.start' });
      const [harness, plain] = db.getJournalSpansForRun('r1', 'c1');
      expect(harness!.invocationId).toBe('inv-a');
      expect(plain!.invocationId).toBeNull();
      expect(db.getJournalSpans('c1')[0]!.invocationId).toBe('inv-a');
    } finally {
      db.close();
    }
  });
});

describe('migration from a journal written before issue #71', () => {
  /** The journal as it stood at 6a6dc28: the provenance columns, no invocation_id, no harness_events. */
  function seedPreChangeJournal(journalPath: string): void {
    const raw = new Database(journalPath);
    raw.exec(`
      CREATE TABLE journal (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT NOT NULL DEFAULT 'default',
        card_id          TEXT NOT NULL,
        station          TEXT NOT NULL,
        attempt          INTEGER NOT NULL,
        name             TEXT NOT NULL,
        attributes_json  TEXT NOT NULL DEFAULT '{}',
        model            TEXT,
        input_tokens     INTEGER,
        output_tokens    INTEGER,
        cost_usd         REAL,
        adapter          TEXT,
        duration_ms      INTEGER,
        usage_unknown    INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens      INTEGER,
        cache_creation_input_tokens  INTEGER,
        binding_stamp            TEXT,
        prompt_template_version  TEXT,
        agent                    TEXT,
        agent_sha256             TEXT,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    raw
      .prepare(
        `INSERT INTO journal (run_id, card_id, station, attempt, name, adapter)
         VALUES ('r1', 'c1', 'coder', 0, 'coder.harness', 'claude-headless')`,
      )
      .run();
    raw.close();
  }

  function tables(journalPath: string): string[] {
    const raw = new Database(journalPath, { readonly: true });
    try {
      return (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    } finally {
      raw.close();
    }
  }

  it('adds harness_events and journal.invocation_id, keeps the old span, and reads its invocation id as NULL', () => {
    const journalPath = join(dir, 'journal.sqlite');
    seedPreChangeJournal(journalPath);
    expect(tables(journalPath)).not.toContain('harness_events');

    const db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
    try {
      const old = db.getJournalSpansForRun('r1', 'c1');
      expect(old).toHaveLength(1);
      expect(old[0]!.adapter).toBe('claude-headless');
      expect(old[0]!.invocationId).toBeNull();

      db.appendJournalSpan({ runId: 'r1', cardId: 'c1', station: 'coder', attempt: 1, name: 'coder.harness', invocationId: 'inv-new' });
      db.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start', invocationId: 'inv-new', attempt: 1 }));
      expect(db.getJournalSpansForRun('r1', 'c1')[1]!.invocationId).toBe('inv-new');
      expect(db.getHarnessEventsForRun('r1', 'c1')).toHaveLength(1);
    } finally {
      db.close();
    }
    expect(tables(journalPath)).toContain('harness_events');
  });

  it('is idempotent: reopening a migrated journal keeps every row', () => {
    const journalPath = join(dir, 'journal.sqlite');
    seedPreChangeJournal(journalPath);
    const first = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
    first.appendHarnessEvent(row({ seq: 0, kind: 'lifecycle', phase: 'start' }));
    first.close();
    const reopened = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
    try {
      expect(reopened.getJournalSpansForRun('r1', 'c1')).toHaveLength(1);
      expect(reopened.getHarnessEventsForRun('r1', 'c1')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
