/**
 * Journal provenance columns: binding_stamp, prompt_template_version, agent,
 * agent_sha256. Additive and nullable, like the WI-567 and issue #5 columns:
 * a span that does not set them, and every row written before they existed,
 * reads back NULL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, DEFAULT_RUN_ID } from './db';

const PROVENANCE_COLUMNS = ['binding_stamp', 'prompt_template_version', 'agent', 'agent_sha256'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-journal-provenance-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function journalColumns(journalPath: string): string[] {
  const raw = new Database(journalPath, { readonly: true });
  try {
    return (raw.prepare('PRAGMA table_info(journal)').all() as { name: string }[]).map((c) => c.name);
  } finally {
    raw.close();
  }
}

describe('journal provenance columns on a fresh journal', () => {
  it('round-trips all four values through appendJournalSpan and both span readers', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      db.appendJournalSpan({
        runId: 'r1', cardId: 'c', station: 's', attempt: 0, name: 's.harness',
        bindingStamp: 'stamp-1',
        promptTemplateVersion: 'ptv-1',
        agent: 'team:coder',
        agentSha256: 'a'.repeat(64),
      });
      for (const span of [db.getJournalSpansForRun('r1', 'c')[0]!, db.getJournalSpans('c')[0]!]) {
        expect(span.bindingStamp).toBe('stamp-1');
        expect(span.promptTemplateVersion).toBe('ptv-1');
        expect(span.agent).toBe('team:coder');
        expect(span.agentSha256).toBe('a'.repeat(64));
      }
    } finally {
      db.close();
    }
  });

  it('reads back NULL for a span that does not set them', () => {
    const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    try {
      db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'c', station: 's', attempt: 0, name: 'hitl.ask' });
      const span = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'c')[0]!;
      expect(span.bindingStamp).toBeNull();
      expect(span.promptTemplateVersion).toBeNull();
      expect(span.agent).toBeNull();
      expect(span.agentSha256).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('journal provenance columns migrate onto an EXISTING journal', () => {
  /** The journal as it stood before the provenance columns: every earlier additive column, none of these. */
  function seedPreProvenanceJournal(journalPath: string): void {
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
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    raw
      .prepare(
        `INSERT INTO journal (run_id, card_id, station, attempt, name, model, input_tokens, output_tokens, cost_usd, adapter)
         VALUES ('default', 'old', 'coder', 0, 'coder.harness', 'sonnet', 100, 10, 0.5, 'claude-headless')`,
      )
      .run();
    raw.close();
  }

  it('adds the columns, keeps the existing row, and reads its provenance back as NULL', () => {
    const journalPath = join(dir, 'journal.sqlite');
    seedPreProvenanceJournal(journalPath);
    expect(journalColumns(journalPath)).not.toContain('binding_stamp');

    const db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
    try {
      const old = db.getJournalSpans('old');
      expect(old).toHaveLength(1);
      expect(old[0]!.adapter).toBe('claude-headless');
      expect(old[0]!.bindingStamp).toBeNull();
      expect(old[0]!.promptTemplateVersion).toBeNull();
      expect(old[0]!.agent).toBeNull();
      expect(old[0]!.agentSha256).toBeNull();

      db.appendJournalSpan({
        runId: DEFAULT_RUN_ID, cardId: 'new', station: 'coder', attempt: 0, name: 'coder.harness',
        bindingStamp: 'stamp-2', promptTemplateVersion: 'ptv-2', agent: 'team:x', agentSha256: 'c'.repeat(64),
      });
      const fresh = db.getJournalSpans('new')[0]!;
      expect(fresh.bindingStamp).toBe('stamp-2');
      expect(fresh.agentSha256).toBe('c'.repeat(64));
    } finally {
      db.close();
    }

    for (const column of PROVENANCE_COLUMNS) {
      expect(journalColumns(journalPath)).toContain(column);
    }
  });

  it('is idempotent: reopening a migrated journal does not fail or duplicate rows', () => {
    const journalPath = join(dir, 'journal.sqlite');
    seedPreProvenanceJournal(journalPath);
    openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath }).close();
    const reopened = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: journalPath });
    try {
      expect(reopened.getJournalSpans('old')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
