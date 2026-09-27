/**
 * Tests for the split persistence layer (WI-290, SPEC §11).
 *
 * conduit.sqlite is split into TWO physical files:
 *   - the STATE DB (transactional, low-volume): cards, station_outputs, outbox,
 *     active_workers, ingress_events
 *   - the JOURNAL DB (append-only, high-volume, its OWN WAL): journal, work_summaries
 * so a hot journal write never contends on the state-DB write lock at fan-out scale.
 *
 * These tests define the contract `src/persistence/db.ts` must satisfy:
 *
 *   openConduitDB({ stateDbPath, journalDbPath }): ConduitDB
 *   SCHEMA_VERSION: number                      // stored as PRAGMA user_version on the state DB
 *   ConduitDB.insertCard(card) / getCard(id)
 *   ConduitDB.recordIngressEvent(eventId, receivedAt)   // throws on duplicate event_id (PK)
 *   ConduitDB.appendJournalSpan(span)                   // attributes pass an allowlist; secrets dropped/masked
 *   ConduitDB.getStationUsage(cardId, station, attempt) // OTel-GenAI-named token/cost row
 *   ConduitDB.getJournalSpans(cardId)
 *   ConduitDB.close()
 *
 * Where it matters, the assertions introspect the ON-DISK schema/content with a raw
 * bun:sqlite connection — testing what is actually persisted, not the wrapper's getters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, SCHEMA_VERSION, DEFAULT_RUN_ID, type ConduitDB } from './db';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-persist-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = openConduitDB({ stateDbPath, journalDbPath });
});

afterEach(() => {
  // Tests may have already closed db (reopen/introspection cases) — guard it.
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Close the conduit handle so a raw connection can introspect on-disk content. */
function closeConduit(): void {
  db?.close();
  db = null;
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card_1',
    run_id: DEFAULT_RUN_ID,
    parent_id: null,
    lane: 'brief',
    status: 'ready',
    attempt: 0,
    wave: 0,
    // WI-355: every card now carries a durable rework_count (default 0). Kept in
    // the factory so the existing round-trip toEqual tests still match getCard,
    // which surfaces the column on the new fresh-DB schema (AC4).
    rework_count: 0,
    owned_paths: ['src/a.ts', 'src/b.ts'],
    ...overrides,
  };
}

function tableNames(database: Database): string[] {
  return database
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
}

function columnNames(database: Database, table: string): string[] {
  return database
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => (r as { name: string }).name);
}

// ---------------------------------------------------------------------------
// AC1 — fresh DB creates the state tables with SPEC §11 columns.
// ---------------------------------------------------------------------------

describe('state schema (AC1, SPEC §11)', () => {
  it('creates all five state tables on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const tables = tableNames(raw);
      for (const expected of ['cards', 'station_outputs', 'outbox', 'active_workers', 'ingress_events']) {
        expect(tables).toContain(expected);
      }
    } finally {
      raw.close();
    }
  });

  it('gives cards the SPEC §11 columns', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const cols = columnNames(raw, 'cards');
      for (const expected of ['id', 'parent_id', 'lane', 'status', 'attempt', 'wave', 'owned_paths']) {
        expect(cols).toContain(expected);
      }
    } finally {
      raw.close();
    }
  });

  it('stamps the state DB with SCHEMA_VERSION via PRAGMA user_version', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = raw.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — journal is a SEPARATE file/WAL; journal write doesn't block state write.
// ---------------------------------------------------------------------------

describe('split state/journal stores (AC2, SPEC §11)', () => {
  it('puts journal tables in the journal file and state tables in the state file', () => {
    closeConduit();
    const rawState = new Database(stateDbPath, { readonly: true });
    const rawJournal = new Database(journalDbPath, { readonly: true });
    try {
      const stateTables = tableNames(rawState);
      const journalTables = tableNames(rawJournal);

      // journal + work_summaries live ONLY in the journal file
      expect(journalTables).toContain('journal');
      expect(journalTables).toContain('work_summaries');
      expect(stateTables).not.toContain('journal');
      expect(stateTables).not.toContain('work_summaries');

      // cards lives ONLY in the state file
      expect(stateTables).toContain('cards');
      expect(journalTables).not.toContain('cards');
    } finally {
      rawState.close();
      rawJournal.close();
    }
  });

  it('runs the journal in WAL mode (its own write-ahead log)', () => {
    closeConduit();
    const rawJournal = new Database(journalDbPath, { readonly: true });
    try {
      const { journal_mode } = rawJournal.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journal_mode.toLowerCase()).toBe('wal');
    } finally {
      rawJournal.close();
    }
  });

  it('does not block a journal write while the state DB write lock is held', () => {
    // An external connection grabs the state-DB write lock and holds it.
    const rawState = new Database(stateDbPath);
    rawState.exec('PRAGMA busy_timeout = 150');
    rawState.exec('BEGIN IMMEDIATE'); // exclusive writer on the STATE file only
    try {
      // The journal lives in a separate file — appending must succeed, not block on
      // the state lock. If the impl wrongly routes journal writes through the state
      // connection, this throws SQLITE_BUSY (or hangs to timeout) and the test fails.
      expect(() =>
        db!.appendJournalSpan({
          runId: DEFAULT_RUN_ID,
          cardId: 'card_1',
          station: 'brief',
          attempt: 0,
          name: 'brief.run',
        }),
      ).not.toThrow();
      expect(db!.getJournalSpans('card_1')).toHaveLength(1);
    } finally {
      rawState.exec('ROLLBACK');
      rawState.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — insertCard → getCard round-trips every field.
// ---------------------------------------------------------------------------

describe('card round-trip (AC3)', () => {
  it('round-trips a top-level card (parent_id null) with all fields', () => {
    const card = makeCard({ id: 'epic_1', parent_id: null, owned_paths: ['src/x.ts'] });
    db!.insertCard(card);
    expect(db!.getCard(DEFAULT_RUN_ID, 'epic_1')).toEqual(card);
  });

  it('round-trips a child card (parent_id set, multi-path owned_paths)', () => {
    const card = makeCard({
      id: 'child_1',
      parent_id: 'epic_1',
      lane: 'build',
      status: 'working',
      attempt: 2,
      wave: 1,
      owned_paths: ['src/feature/a.ts', 'src/feature/b.ts', 'src/feature/c.ts'],
    });
    db!.insertCard(card);

    const got = db!.getCard(DEFAULT_RUN_ID, 'child_1');
    expect(got).toEqual(card);
    // owned_paths must deserialize back into a real array, not a JSON string.
    expect(Array.isArray(got!.owned_paths)).toBe(true);
    expect(got!.owned_paths).toHaveLength(3);
    expect(got!.parent_id).toBe('epic_1');
  });

  it('returns null for an unknown card id', () => {
    expect(db!.getCard(DEFAULT_RUN_ID, 'does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 — journal records per-station token/cost with OTel-GenAI field names.
// ---------------------------------------------------------------------------

describe('OTel-GenAI cost attribution (AC4)', () => {
  it('records token/cost under gen_ai.* field names retrievable per (card, station, attempt)', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_1',
      station: 'brief',
      attempt: 0,
      name: 'brief.run',
      usage: { model: 'claude-x', inputTokens: 1200, outputTokens: 340, costUsd: 0.018 },
    });

    const usage = db!.getStationUsage('card_1', 'brief', 0);
    expect(usage).not.toBeNull();
    // OTel-GenAI-aligned field NAMES are the contract (portability to OTel backends).
    expect(usage!['gen_ai.usage.input_tokens']).toBe(1200);
    expect(usage!['gen_ai.usage.output_tokens']).toBe(340);
    expect(usage!['gen_ai.request.model']).toBe('claude-x');
    expect(usage!['cost_usd']).toBeCloseTo(0.018);
  });

  it('returns null when no usage was recorded for that station/attempt', () => {
    expect(db!.getStationUsage('card_1', 'brief', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5 — incompatible schema version errors instead of silently migrating.
// ---------------------------------------------------------------------------

describe('schema version guard (AC5)', () => {
  it('throws when reopening a DB with an unknown/incompatible user_version', () => {
    closeConduit();

    // Tamper the persisted version to an unknown future value.
    const raw = new Database(stateDbPath);
    raw.exec('PRAGMA user_version = 999999');
    raw.close();

    expect(() => openConduitDB({ stateDbPath, journalDbPath })).toThrow();
  });

  it('does NOT silently migrate — the tampered version is left untouched after the failed open', () => {
    closeConduit();

    const raw = new Database(stateDbPath);
    raw.exec('PRAGMA user_version = 999999');
    raw.close();

    try {
      db = openConduitDB({ stateDbPath, journalDbPath });
    } catch {
      db = null; // expected
    }

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      // Still the tampered value — no migration rewrote it to SCHEMA_VERSION.
      expect(user_version).toBe(999999);
    } finally {
      check.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — ingress_events.event_id is a PRIMARY KEY; duplicate insert is rejected.
// ---------------------------------------------------------------------------

describe('ingress dedup (AC6, §4A)', () => {
  it('declares event_id as the primary key of ingress_events', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const pkCols = raw
        .query('PRAGMA table_info(ingress_events)')
        .all()
        .filter((r) => (r as { pk: number }).pk > 0)
        .map((r) => (r as { name: string }).name);
      expect(pkCols).toEqual(['event_id']);
    } finally {
      raw.close();
    }
  });

  it('accepts a first event then rejects a duplicate event_id', () => {
    db!.recordIngressEvent('evt-abc', 1000);
    // A listener restart re-delivering the same event must NOT create a second row.
    expect(() => db!.recordIngressEvent('evt-abc', 2000)).toThrow();
  });

  it('accepts distinct event ids', () => {
    db!.recordIngressEvent('evt-1', 1000);
    expect(() => db!.recordIngressEvent('evt-2', 1001)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC7 — secret hygiene: journal allowlist; secrets never stored verbatim.
// ---------------------------------------------------------------------------

describe('journal secret hygiene (AC7, SPEC §11 L2)', () => {
  const SECRET = 'sk-live-SUPERSECRET-abcdef1234567890';

  it('never writes a secret-bearing attribute verbatim to the journal file', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_1',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: {
        'gen_ai.request.model': 'claude-x', // allowed, non-sensitive
        api_key: SECRET, // sensitive — must be dropped or masked
        authorization: `Bearer ${SECRET}`, // sensitive — must be dropped or masked
      },
    });

    closeConduit();

    // Scan everything actually persisted in the journal table for the raw secret.
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT * FROM journal').all();
      expect(rows.length).toBeGreaterThan(0);
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain(SECRET);
    } finally {
      raw.close();
    }
  });

  it('keeps allowlisted non-sensitive attributes while excluding the secret', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_1',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: {
        'gen_ai.request.model': 'claude-x',
        api_key: SECRET,
      },
    });

    const spans = db!.getJournalSpans('card_1');
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;

    // The allowlisted, non-sensitive attribute survives.
    expect(attrs['gen_ai.request.model']).toBe('claude-x');
    // The secret value is never exposed verbatim through the accessor either.
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Finding #9 — getStationUsage SUMs every usage span for the triple.
// ---------------------------------------------------------------------------

describe('issue #5 — the cache split must not move the budget', () => {
  it('counts ALL FOUR token classes in the run total', () => {
    // THE REGRESSION THIS GUARDS: before the split, the harness path summed
    // every class into input_tokens, so `input + output` WAS the true total.
    // Now input_tokens is uncached input only — summing just those two would
    // silently drop cache reads, which are the majority of real traffic, and
    // the run budget would stop tripping.
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_split',
      station: 'draft',
      attempt: 0,
      name: 'draft.harness',
      usage: {
        model: 'claude-opus-5',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.05,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
      },
    });

    expect(db!.getRunUsageTotals(DEFAULT_RUN_ID).tokens).toBe(2000);
  });

  it('counts a PRE-split row exactly once', () => {
    // A row written before the migration carries the summed total in
    // input_tokens with both cache columns NULL. COALESCE must leave it at its
    // original total rather than dropping it or double-counting it.
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_legacy',
      station: 'draft',
      attempt: 0,
      name: 'draft.harness',
      usage: { model: 'legacy', inputTokens: 2000, outputTokens: 0, costUsd: 0.05 },
    });

    expect(db!.getRunUsageTotals(DEFAULT_RUN_ID).tokens).toBe(2000);
  });

  it('round-trips the cache columns so the cache fraction is measurable', () => {
    // The question issue #5 could not answer: "what fraction of spend is cache
    // reads?" It is now a division, not an inference.
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_frac',
      station: 'draft',
      attempt: 0,
      name: 'draft.harness',
      usage: {
        model: 'claude-opus-5',
        inputTokens: 100,
        outputTokens: 100,
        costUsd: 0.01,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
      },
    });

    const usage = db!.getStationUsage('card_frac', 'draft', 0)!;
    expect(usage['gen_ai.usage.cache_read_input_tokens']).toBe(800);
    // output_tokens is genuinely populated now — it was 0 on every row before.
    expect(usage['gen_ai.usage.output_tokens']).toBe(100);
  });
});

describe('getStationUsage aggregation (finding #9)', () => {
  it('sums input/output tokens and cost across MULTIPLE spans for one (card,station,attempt)', () => {
    // Two billed calls within the same execution attempt (e.g. a tool-loop turn).
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_sum',
      station: 'build',
      attempt: 0,
      name: 'build.call1',
      usage: { model: 'claude-x', inputTokens: 1000, outputTokens: 200, costUsd: 0.01 },
    });
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_sum',
      station: 'build',
      attempt: 0,
      name: 'build.call2',
      usage: { model: 'claude-x', inputTokens: 500, outputTokens: 80, costUsd: 0.004 },
    });

    const usage = db!.getStationUsage('card_sum', 'build', 0);
    expect(usage).not.toBeNull();
    expect(usage!['gen_ai.usage.input_tokens']).toBe(1500);
    expect(usage!['gen_ai.usage.output_tokens']).toBe(280);
    expect(usage!['gen_ai.request.model']).toBe('claude-x');
    expect(usage!['cost_usd']).toBeCloseTo(0.014);
  });

  it('returns the single span unchanged when only one was recorded', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_one',
      station: 'brief',
      attempt: 0,
      name: 'brief.run',
      usage: { model: 'claude-y', inputTokens: 42, outputTokens: 7, costUsd: 0.0123 },
    });

    expect(db!.getStationUsage('card_one', 'brief', 0)).toEqual({
      'gen_ai.usage.input_tokens': 42,
      'gen_ai.usage.output_tokens': 7,
      // A span written WITHOUT the issue-#5 cache split reads back 0, not null:
      // the columns are absent for this row, and 0 is the honest aggregate for
      // "no cache tokens were reported".
      'gen_ai.usage.cache_read_input_tokens': 0,
      'gen_ai.usage.cache_creation_input_tokens': 0,
      'gen_ai.request.model': 'claude-y',
      cost_usd: 0.0123,
    });
  });

  it('returns null when no usage span exists for the triple', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_nousage',
      station: 'brief',
      attempt: 0,
      name: 'brief.run', // no usage payload at all
    });
    expect(db!.getStationUsage('card_nousage', 'brief', 0)).toBeNull();
    expect(db!.getStationUsage('card_nousage', 'brief', 99)).toBeNull();
  });

  it('does not bleed cost across attempts of the same station', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_attempts',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      usage: { model: 'm', inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
    });
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_attempts',
      station: 'build',
      attempt: 1,
      name: 'build.run',
      usage: { model: 'm', inputTokens: 999, outputTokens: 99, costUsd: 0.5 },
    });

    expect(db!.getStationUsage('card_attempts', 'build', 0)!['gen_ai.usage.input_tokens']).toBe(100);
    expect(db!.getStationUsage('card_attempts', 'build', 1)!['gen_ai.usage.input_tokens']).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Finding #10 — hot-path indexes exist on disk.
// ---------------------------------------------------------------------------

describe('hot-path indexes (finding #10)', () => {
  function indexNames(database: Database): string[] {
    return database
      .query("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => (r as { name: string }).name);
  }

  it('creates the active_workers(station) index in the state DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(indexNames(raw)).toContain('idx_active_workers_station');
    } finally {
      raw.close();
    }
  });

  it('creates the journal card and (card,station,attempt) indexes in the journal DB', () => {
    closeConduit();
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const idx = indexNames(raw);
      expect(idx).toContain('idx_journal_card');
      expect(idx).toContain('idx_journal_cqa');
    } finally {
      raw.close();
    }
  });

  // the pre-public ingress-deduplication review: getFlowPathForRun queried ingress_events by run_id with no
  // supporting index — an unbounded scan as ingress events grow.
  it('creates a partial index on ingress_events(run_id, received_at) for getFlowPathForRun', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(indexNames(raw)).toContain('idx_ingress_events_run_id');
    } finally {
      raw.close();
    }
  });

  it("getFlowPathForRun's query plan uses the index (SEARCH, not a table SCAN)", () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const plan = raw
        .query(
          `EXPLAIN QUERY PLAN
           SELECT flow_path FROM ingress_events
           WHERE run_id = 'run-1' AND flow_path IS NOT NULL
           ORDER BY received_at DESC LIMIT 1`,
        )
        .all()
        .map((r) => (r as { detail: string }).detail)
        .join(' | ');
      expect(plan).toContain('USING INDEX idx_ingress_events_run_id');
      expect(plan).not.toContain('SCAN ingress_events');
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {
      raw.close();
    }
  });

  // the pre-public run-slot and HITL review: listRedrivable filtered spawn_state and sorted received_at
  // with no supporting index — a growing full-table scan + sort on every boot
  // re-drive and periodic sweep.
  it('creates a partial index on ingress_events(spawn_state, received_at) for listRedrivable', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(indexNames(raw)).toContain('idx_ingress_events_redrivable');
    } finally {
      raw.close();
    }
  });

  it("listRedrivable's query plan uses the index (no full scan of ingress_events)", () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const plan = raw
        .query(
          `EXPLAIN QUERY PLAN
           SELECT event_id FROM ingress_events
           WHERE spawn_state IN ('accepted', 'failed') AND spawn_attempts < 3
           ORDER BY received_at ASC`,
        )
        .all()
        .map((r) => (r as { detail: string }).detail)
        .join(' | ');
      expect(plan).toContain('idx_ingress_events_redrivable');
      expect(plan).not.toContain('SCAN ingress_events');
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding #11 — secret filter is recursive and matches vendor-prefixed keys.
// ---------------------------------------------------------------------------

describe('recursive secret hygiene (finding #11, SPEC §11 L2)', () => {
  const SECRET = 'sk-live-NESTEDSECRET-deadbeef99887766';

  function persistedJournal(): string {
    closeConduit();
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      return JSON.stringify(raw.query('SELECT * FROM journal').all());
    } finally {
      raw.close();
    }
  }

  it('drops a secret nested under a non-sensitive parent key (headers.Authorization)', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_nested',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      },
    });
    expect(persistedJournal()).not.toContain(SECRET);
  });

  it('drops a secret nested under config.api_key', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_cfg',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: { config: { region: 'us-east-1', api_key: SECRET } },
    });
    expect(persistedJournal()).not.toContain(SECRET);
  });

  it('drops vendor- and header-prefixed key variants (openai_api_key, x-api-key, *_token, *_secret)', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_variants',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: {
        openai_api_key: SECRET,
        'x-api-key': SECRET,
        gh_token: SECRET,
        db_password: SECRET,
        aws_secret_access_key: SECRET,
        bearer: SECRET,
        keep_me: 'visible', // non-sensitive — must survive
      },
    });

    const spans = db!.getJournalSpans('card_variants');
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    expect(attrs['keep_me']).toBe('visible');
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
    expect(persistedJournal()).not.toContain(SECRET);
  });

  it('preserves a non-sensitive nested attribute while dropping a sibling secret', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_mixed',
      station: 'build',
      attempt: 0,
      name: 'build.run',
      attributes: { request: { model: 'claude-x', api_key: SECRET } },
    });
    const attrs = db!.getJournalSpans('card_mixed')[0]!.attributes;
    expect((attrs['request'] as Record<string, unknown>)['model']).toBe('claude-x');
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Finding #12 — getCard validates the row at the trust boundary.
// ---------------------------------------------------------------------------

describe('getCard trust-boundary validation (finding #12)', () => {
  it('throws a contextful error (with card id) when status is not a legal FSM state', () => {
    // Write a bogus status directly, bypassing insertCard's typed path.
    const raw = new Database(stateDbPath);
    raw
      .prepare(
        `INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('${DEFAULT_RUN_ID}', 'bad_status', NULL, 'brief', 'not-a-status', 0, 0, '[]')`,
      )
      .run();
    raw.close();

    expect(() => db!.getCard(DEFAULT_RUN_ID, 'bad_status')).toThrow(/bad_status/);
    expect(() => db!.getCard(DEFAULT_RUN_ID, 'bad_status')).toThrow(/not-a-status/);
  });

  it('throws with the card id and column name when owned_paths is malformed JSON', () => {
    const raw = new Database(stateDbPath);
    raw
      .prepare(
        `INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('${DEFAULT_RUN_ID}', 'bad_json', NULL, 'brief', 'ready', 0, 0, '[not valid json')`,
      )
      .run();
    raw.close();

    expect(() => db!.getCard(DEFAULT_RUN_ID, 'bad_json')).toThrow(/bad_json/);
    expect(() => db!.getCard(DEFAULT_RUN_ID, 'bad_json')).toThrow(/owned_paths/);
  });

  it('still round-trips a well-formed card unchanged', () => {
    const card = makeCard({ id: 'good', status: 'working', lane: 'build' });
    db!.insertCard(card);
    expect(db!.getCard(DEFAULT_RUN_ID, 'good')).toEqual(card);
  });
});

// ---------------------------------------------------------------------------
// Finding #27 — station_outputs carries binding_stamp + UNIQUE(card,station,attempt).
// ---------------------------------------------------------------------------

describe('station_outputs checkpoint shape (finding #27)', () => {
  it('has a binding_stamp column', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const cols = columnNames(raw, 'station_outputs');
      expect(cols).toContain('binding_stamp');
    } finally {
      raw.close();
    }
  });

  it('rejects a duplicate (run_id, card_id, station, attempt) checkpoint via the UNIQUE constraint', () => {
    const raw = new Database(stateDbPath);
    try {
      raw
        .prepare(
          `INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash, binding_stamp)
           VALUES ('${DEFAULT_RUN_ID}', 'c1', 'build', 0, 'h1', 'stamp-a')`,
        )
        .run();
      // Second checkpoint for the same (run_id, card, station, attempt) quad must be rejected.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash, binding_stamp)
             VALUES ('${DEFAULT_RUN_ID}', 'c1', 'build', 0, 'h2', 'stamp-b')`,
          )
          .run(),
      ).toThrow();

      // A different attempt for the same (run_id, card, station) is fine.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash, binding_stamp)
             VALUES ('${DEFAULT_RUN_ID}', 'c1', 'build', 1, 'h3', 'stamp-c')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it('supports INSERT OR REPLACE upsert semantics for a re-checkpoint of the same (run_id, card, station, attempt)', () => {
    const raw = new Database(stateDbPath);
    try {
      raw
        .prepare(
          `INSERT OR REPLACE INTO station_outputs (run_id, card_id, station, attempt, findings_hash, binding_stamp)
           VALUES ('${DEFAULT_RUN_ID}', 'c2', 'build', 0, 'h1', 'stamp-old')`,
        )
        .run();
      raw
        .prepare(
          `INSERT OR REPLACE INTO station_outputs (run_id, card_id, station, attempt, findings_hash, binding_stamp)
           VALUES ('${DEFAULT_RUN_ID}', 'c2', 'build', 0, 'h1', 'stamp-new')`,
        )
        .run();

      const rows = raw
        .query(`SELECT binding_stamp FROM station_outputs WHERE run_id='${DEFAULT_RUN_ID}' AND card_id='c2' AND station='build' AND attempt=0`)
        .all() as { binding_stamp: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.binding_stamp).toBe('stamp-new');
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WI-355 — durable per-card rework_count (FR-8, NFR-1/2).
//
// The cards table carries a rework_count column so the per-card rework cap is
// enforced durably across a crash/resume, not just in-memory within one
// process. SCHEMA_VERSION was bumped from 2 to 3. The v2→v3 migration is
// additive (ALTER TABLE ADD COLUMN rework_count) and runs automatically on
// open. Genuinely incompatible versions (< 2 or > SCHEMA_VERSION) still throw.
// ---------------------------------------------------------------------------

/**
 * The state-DB schema version that shipped BEFORE the WI-355 rework_count
 * migration. A fresh DB must now stamp a HIGHER version. A DB stamped at this
 * version is MIGRATED automatically (additive v2→v3). This is a fixed historical
 * constant, not a moving target.
 */
const PREVIOUS_SCHEMA_VERSION = 2;

/**
 * A schema version that is genuinely incompatible and cannot be migrated —
 * used to test the fail-closed rejection path. Must be less than
 * PREVIOUS_SCHEMA_VERSION so it pre-dates all known migrations.
 */
const INCOMPATIBLE_SCHEMA_VERSION = 1;

describe('durable rework_count — fresh schema (WI-355, AC1)', () => {
  it('adds a rework_count column to the cards table', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'cards')).toContain('rework_count');
    } finally {
      raw.close();
    }
  });

  it('defaults rework_count to 0 for a row inserted without it (DDL DEFAULT 0)', () => {
    // Raw insert that omits rework_count — exercises the column DEFAULT, then the
    // kernel read path must surface 0 on the returned Card.
    const raw = new Database(stateDbPath);
    raw
      .prepare(
        `INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('${DEFAULT_RUN_ID}', 'defcard', NULL, 'brief', 'ready', 0, 0, '[]')`,
      )
      .run();
    raw.close();

    expect(db!.getCard(DEFAULT_RUN_ID, 'defcard')!.rework_count).toBe(0);
  });

  it('bumps SCHEMA_VERSION past the pre-migration version (so old DBs fail closed)', () => {
    // If this regresses, a fresh DB would stamp the OLD version and an old DB
    // would be wrongly accepted as current — the exact silent migration AC3 bans.
    expect(SCHEMA_VERSION).toBeGreaterThan(PREVIOUS_SCHEMA_VERSION);
  });
});

describe('durable rework_count — persistence across reopen (WI-355, AC2)', () => {
  it('insertCard persists rework_count and getCard returns it on the Card', () => {
    db!.insertCard(makeCard({ id: 'rc_insert', rework_count: 3 }));
    expect(db!.getCard(DEFAULT_RUN_ID, 'rc_insert')!.rework_count).toBe(3);
  });

  it('round-trips a non-zero rework_count alongside the other card fields', () => {
    const card = makeCard({ id: 'rc_full', attempt: 2, wave: 1, rework_count: 4 });
    db!.insertCard(card);
    expect(db!.getCard(DEFAULT_RUN_ID, 'rc_full')).toEqual(card);
  });

  it('persists an incremented rework_count across a close/reopen of the state DB (NFR-2)', () => {
    db!.insertCard(makeCard({ id: 'rc_durable', rework_count: 0 }));

    // Simulate the FSM bumping the count on QC_REJECT. The kernel mutates cards
    // through the raw state connection (the same path claim.ts uses for atomic
    // card writes), so we exercise that path here rather than a typed setter.
    const state = db!.getStateDb();
    const bump = state.prepare(
      'UPDATE cards SET rework_count = rework_count + 1 WHERE run_id = $run_id AND id = $id'
    );
    bump.run({ $run_id: DEFAULT_RUN_ID, $id: 'rc_durable' });
    bump.run({ $run_id: DEFAULT_RUN_ID, $id: 'rc_durable' });

    // Reopen from disk — the durable count must survive the restart.
    closeConduit();
    db = openConduitDB({ stateDbPath, journalDbPath });

    expect(db!.getCard(DEFAULT_RUN_ID, 'rc_durable')!.rework_count).toBe(2);
  });
});

describe('durable rework_count — fail-closed version bump (WI-355, AC3)', () => {
  /**
   * Stamp the on-disk state DB at an incompatible (pre-migration) version and
   * drop the handle. v1 pre-dates all known migrations and cannot be upgraded.
   */
  function stampIncompatibleVersion(): void {
    closeConduit();
    const raw = new Database(stateDbPath);
    raw.exec(`PRAGMA user_version = ${INCOMPATIBLE_SCHEMA_VERSION}`);
    raw.close();
  }

  it('rejects opening a state DB stamped at a genuinely incompatible version', () => {
    stampIncompatibleVersion();
    expect(() => openConduitDB({ stateDbPath, journalDbPath })).toThrow(/schema mismatch/i);
  });

  it('names the found incompatible version in the schema-mismatch error', () => {
    stampIncompatibleVersion();
    expect(() => openConduitDB({ stateDbPath, journalDbPath })).toThrow(
      new RegExp(`version ${INCOMPATIBLE_SCHEMA_VERSION}\\b`),
    );
  });

  it('leaves the incompatible version stamp untouched after the failed open', () => {
    stampIncompatibleVersion();

    try {
      db = openConduitDB({ stateDbPath, journalDbPath });
    } catch {
      db = null; // expected — fail-closed
    }

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(INCOMPATIBLE_SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });

  it('also rejects a future version greater than SCHEMA_VERSION', () => {
    closeConduit();
    const raw = new Database(stateDbPath);
    raw.exec('PRAGMA user_version = 999999');
    raw.close();

    expect(() => openConduitDB({ stateDbPath, journalDbPath })).toThrow(/schema mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// v2→v3 state-DB migration (Bug fix: openConduitDB now migrates instead of
// throwing when the existing DB is at schema version 2).
// ---------------------------------------------------------------------------

describe('v2→v3 state DB migration', () => {
  /**
   * Build a v2 fixture on disk: create the cards table WITHOUT rework_count
   * (as it existed before this migration), stamp user_version = 2, and close.
   * The beforeEach openConduitDB call is bypassed — we open on the raw path.
   */
  function buildV2Fixture(): void {
    // Close the fresh DB that beforeEach already opened.
    closeConduit();

    const raw = new Database(stateDbPath);
    // Recreate cards table as it existed in v2 — no rework_count column.
    raw.exec('DROP TABLE IF EXISTS cards');
    raw.exec(`
      CREATE TABLE cards (
        id           TEXT PRIMARY KEY,
        parent_id    TEXT,
        lane         TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 0,
        wave         INTEGER NOT NULL DEFAULT 0,
        owned_paths  TEXT NOT NULL DEFAULT '[]'
      )
    `);
    // Seed one row to verify DEFAULT 0 is applied to pre-existing rows on migration.
    raw.prepare(
      "INSERT INTO cards (id, lane, status, owned_paths) VALUES ('pre_existing', 'brief', 'ready', '[]')",
    ).run();
    raw.exec(`PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION}`);
    raw.close();
  }

  it('migrates a v2 state DB to v3 without throwing', () => {
    buildV2Fixture();
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('stamps the migrated DB with SCHEMA_VERSION (3)', () => {
    buildV2Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });

  it('adds the rework_count column to an existing cards table', () => {
    buildV2Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(check, 'cards')).toContain('rework_count');
    } finally {
      check.close();
    }
  });

  it('pre-existing rows default rework_count to 0 after migration', () => {
    buildV2Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    // The row seeded before migration should surface rework_count = 0.
    expect(db!.getCard(DEFAULT_RUN_ID, 'pre_existing')!.rework_count).toBe(0);
  });

  it('allows insertCard and getCard to work normally after migration', () => {
    buildV2Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    const card = makeCard({ id: 'post_migrate', rework_count: 2 });
    db!.insertCard(card);
    expect(db!.getCard(DEFAULT_RUN_ID, 'post_migrate')).toEqual(card);
  });
});

// ---------------------------------------------------------------------------
// Existing journal DB self-heal: card_log is created even if the journal file
// pre-dates the card_log table (Bug fix: JOURNAL_DDL is now always executed —
// idempotent CREATE IF NOT EXISTS statements self-heal old journals).
// ---------------------------------------------------------------------------

describe('journal DB self-heal — card_log added to existing journal', () => {
  /**
   * Simulate a pre-card_log journal fixture: beforeEach already opened a fresh
   * DB (creating all tables including card_log). We close the conduit handle,
   * then drop card_log and its index to leave only the tables that existed before
   * this version. This models a real on-disk journal from before card_log was added.
   */
  function buildOldJournalFixture(): void {
    closeConduit();

    const rawJournal = new Database(journalDbPath);
    // Remove card_log and its index, simulating a pre-v3 journal file.
    rawJournal.exec('DROP INDEX IF EXISTS idx_card_log_card');
    rawJournal.exec('DROP TABLE IF EXISTS card_log');
    rawJournal.close();
  }

  it('card_log exists in the journal DB after opening an old journal that lacked it', () => {
    buildOldJournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(journalDbPath, { readonly: true });
    try {
      expect(tableNames(check)).toContain('card_log');
    } finally {
      check.close();
    }
  });

  it('appendCardLog succeeds on an old journal after self-heal', () => {
    buildOldJournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    // appendCardLog must not throw — card_log was created during open.
    expect(() =>
      db!.appendCardLog({
        runId: DEFAULT_RUN_ID,
        cardId: 'card_heal',
        station: 'brief',
        attempt: 0,
        kind: 'entered_lane',
        sourceLane: 'intake',
        destLane: 'brief',
        reasonClass: 'forward',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — state DB must run in WAL mode (SPEC §11).
//
// `openConduitDB` enables WAL on the journal DB but was missing the
// `PRAGMA journal_mode = WAL` call on the state DB. In default rollback-journal
// mode, `BEGIN IMMEDIATE` writers (the atomic claim) block all concurrent
// readers, breaking the tick's read-only queries. SPEC §11 requires WAL on
// both stores.
// ---------------------------------------------------------------------------

describe('state DB WAL mode (SPEC §11, Fix 1)', () => {
  it('opens the state DB in WAL journal mode', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const row = raw.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe('wal');
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — partial v2→v3 migration recovery (untested branch).
//
// The v2→v3 migration catches `duplicate column name` when `rework_count` was
// already added before the PRAGMA stamp (crash-recovery). This simulates that
// state: a v2-stamped DB whose `cards` table already has `rework_count`.
// ---------------------------------------------------------------------------

describe('v2→v3 partial migration recovery (Fix 2)', () => {
  /**
   * Build a "crash mid-migration" fixture: the cards table already has
   * `rework_count` (the ALTER TABLE ran), but user_version is still 2 (the
   * PRAGMA stamp never executed). This is the exact state a process crash
   * between the two operations would leave behind.
   */
  function buildPartialMigrationFixture(): void {
    closeConduit();

    const raw = new Database(stateDbPath);
    // Start from the v2 schema (no rework_count), then manually add the column —
    // simulating the ALTER TABLE succeeding but the PRAGMA stamp not running.
    raw.exec('DROP TABLE IF EXISTS cards');
    raw.exec(`
      CREATE TABLE cards (
        id           TEXT PRIMARY KEY,
        parent_id    TEXT,
        lane         TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 0,
        wave         INTEGER NOT NULL DEFAULT 0,
        owned_paths  TEXT NOT NULL DEFAULT '[]'
      )
    `);
    // The column is already present — simulates the partial migration.
    raw.exec('ALTER TABLE cards ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0');
    raw.prepare(
      "INSERT INTO cards (id, lane, status, owned_paths) VALUES ('partial_seed', 'brief', 'ready', '[]')",
    ).run();
    // Stamp as v2 — the PRAGMA update never ran.
    raw.exec('PRAGMA user_version = 2');
    raw.close();
  }

  it('succeeds (no throw) when rework_count was already added before the version stamp', () => {
    buildPartialMigrationFixture();
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('stamps the recovered DB at SCHEMA_VERSION (3)', () => {
    buildPartialMigrationFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });

  it('insertCard and getCard work normally after partial-migration recovery', () => {
    buildPartialMigrationFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    const card = makeCard({ id: 'post_partial', rework_count: 1 });
    db!.insertCard(card);
    expect(db!.getCard(DEFAULT_RUN_ID, 'post_partial')).toEqual(card);
  });

  it('pre-existing seed row defaults rework_count to 0 after recovery', () => {
    buildPartialMigrationFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    expect(db!.getCard(DEFAULT_RUN_ID, 'partial_seed')!.rework_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WI-474 — run_id dimension: schema migration v5→v6
//
// Every per-run table (cards, station_outputs, outbox, active_workers, journal,
// card_log) gains a run_id column. cards and active_workers get composite PKs.
// outbox and station_outputs get new composite UNIQUE constraints.
// A new `runs` table is added. SCHEMA_VERSION bumps to 6.
// An existing v5 DB migrates in place with no data loss.
// ---------------------------------------------------------------------------

/**
 * The schema version that shipped BEFORE this migration — a fixed historical
 * constant used to build v5 fixtures and verify the version ladder.
 */
const V5_SCHEMA_VERSION = 5;

/** Helper: build a minimal v5 state-DB fixture on disk and close it. */
function buildV5StateFixture(opts: {
  seedCards?: Array<{ id: string; lane: string; status: string }>;
  seedOutbox?: Array<{ idempotency_key: string }>;
  seedStationOutputs?: Array<{ card_id: string; station: string; attempt: number; findings_hash: string }>;
  seedActiveWorkers?: Array<{ card_id: string; station: string; worker_id: string; lease_until: number }>;
} = {}): void {
  closeConduit();

  const raw = new Database(stateDbPath);

  // Drop and recreate the v5 schema (no run_id; cards PK is just `id`).
  raw.exec('DROP TABLE IF EXISTS cards');
  raw.exec('DROP TABLE IF EXISTS station_outputs');
  raw.exec('DROP TABLE IF EXISTS outbox');
  raw.exec('DROP TABLE IF EXISTS active_workers');
  raw.exec('DROP TABLE IF EXISTS ingress_events');
  raw.exec('DROP TABLE IF EXISTS runs');

  raw.exec(`
    CREATE TABLE cards (
      id           TEXT PRIMARY KEY,
      parent_id    TEXT,
      lane         TEXT NOT NULL,
      status       TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      wave         INTEGER NOT NULL DEFAULT 0,
      owned_paths  TEXT NOT NULL DEFAULT '[]',
      rework_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  raw.exec(`
    CREATE TABLE station_outputs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id        TEXT NOT NULL,
      station        TEXT NOT NULL,
      attempt        INTEGER NOT NULL,
      findings_hash  TEXT NOT NULL,
      payload_json   TEXT NOT NULL DEFAULT '{}',
      return_to      TEXT,
      binding_stamp  TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (card_id, station, attempt)
    )
  `);
  raw.exec(`
    CREATE TABLE outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key  TEXT NOT NULL UNIQUE,
      payload_json     TEXT NOT NULL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      delivered_at     INTEGER
    )
  `);
  raw.exec(`
    CREATE TABLE active_workers (
      card_id     TEXT NOT NULL,
      station     TEXT NOT NULL,
      worker_id   TEXT NOT NULL,
      started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      lease_until INTEGER NOT NULL,
      pid         INTEGER,
      PRIMARY KEY (card_id, station)
    )
  `);
  raw.exec(`
    CREATE TABLE ingress_events (
      event_id       TEXT    PRIMARY KEY,
      received_at    INTEGER NOT NULL,
      spawn_state    TEXT    NOT NULL DEFAULT 'accepted',
      spawn_attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_active_workers_station ON active_workers(station)`);

  for (const c of opts.seedCards ?? []) {
    raw.prepare("INSERT INTO cards (id, lane, status, owned_paths) VALUES ($id, $lane, $status, '[]')")
      .run({ $id: c.id, $lane: c.lane, $status: c.status });
  }
  for (const o of opts.seedOutbox ?? []) {
    raw.prepare("INSERT INTO outbox (idempotency_key, payload_json) VALUES ($k, '{}')")
      .run({ $k: o.idempotency_key });
  }
  for (const s of opts.seedStationOutputs ?? []) {
    raw.prepare(
      "INSERT INTO station_outputs (card_id, station, attempt, findings_hash) VALUES ($c, $s, $a, $h)"
    ).run({ $c: s.card_id, $s: s.station, $a: s.attempt, $h: s.findings_hash });
  }
  for (const w of opts.seedActiveWorkers ?? []) {
    raw.prepare(
      "INSERT INTO active_workers (card_id, station, worker_id, lease_until) VALUES ($c, $s, $w, $l)"
    ).run({ $c: w.card_id, $s: w.station, $w: w.worker_id, $l: w.lease_until });
  }

  raw.exec(`PRAGMA user_version = ${V5_SCHEMA_VERSION}`);
  raw.close();
}

// AC-1: Fresh DB — all six per-run tables + runs table + run_id column + SCHEMA_VERSION = 8.

describe('WI-474 AC-1: fresh DB gains run_id on all per-run tables and a runs table', () => {
  it('SCHEMA_VERSION is 10', () => {
    expect(SCHEMA_VERSION).toBe(11);
  });

  it('PRAGMA user_version is 10 on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = raw.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(11);
    } finally {
      raw.close();
    }
  });

  it('cards table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'cards')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('station_outputs table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'station_outputs')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('outbox table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'outbox')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('active_workers table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'active_workers')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('journal table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'journal')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('card_log table has a run_id column on a fresh DB', () => {
    closeConduit();
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'card_log')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('creates the runs table on a fresh DB', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(tableNames(raw)).toContain('runs');
    } finally {
      raw.close();
    }
  });

  it.each([['run_id'], ['flow'], ['input_fingerprint'], ['status'], ['outcome'], ['created_at']])(
    'runs table has a %s column',
    (col) => {
      closeConduit();
      const raw = new Database(stateDbPath, { readonly: true });
      try {
        expect(columnNames(raw, 'runs')).toContain(col);
      } finally {
        raw.close();
      }
    }
  );
});

// AC-2: cards composite PK is (run_id, id).

describe('WI-474 AC-2: cards composite PRIMARY KEY (run_id, id)', () => {
  it('two cards with the same id but different run_id coexist as distinct rows', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count) VALUES ($r, $id, NULL, 'brief', 'ready', 0, 0, '[]', 0)"
    ).run({ $r: 'run-A', $id: 'card_shared' });
    raw.prepare(
      "INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count) VALUES ($r, $id, NULL, 'build', 'working', 0, 0, '[]', 0)"
    ).run({ $r: 'run-B', $id: 'card_shared' });

    const rows = raw.query(
      "SELECT run_id, id FROM cards WHERE id = 'card_shared' ORDER BY run_id"
    ).all() as { run_id: string; id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.run_id).toBe('run-A');
    expect(rows[1]!.run_id).toBe('run-B');
  });

  it('inserting two cards with the same run_id AND same id raises a PK violation', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count) VALUES ('run-X', 'dup', NULL, 'brief', 'ready', 0, 0, '[]', 0)"
    ).run();
    expect(() =>
      raw.prepare(
        "INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count) VALUES ('run-X', 'dup', NULL, 'brief', 'ready', 0, 0, '[]', 0)"
      ).run()
    ).toThrow();
  });
});

// AC-3: active_workers composite PK is (run_id, card_id, station).

describe('WI-474 AC-3: active_workers composite PRIMARY KEY (run_id, card_id, station)', () => {
  it('same (card_id, station) under two different run_ids coexist as distinct rows', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO active_workers (run_id, card_id, station, worker_id, lease_until) VALUES ($r, 'c1', 'build', 'w1', 9999)"
    ).run({ $r: 'run-A' });
    raw.prepare(
      "INSERT INTO active_workers (run_id, card_id, station, worker_id, lease_until) VALUES ($r, 'c1', 'build', 'w2', 9999)"
    ).run({ $r: 'run-B' });

    const rows = raw.query(
      "SELECT run_id FROM active_workers WHERE card_id = 'c1' AND station = 'build' ORDER BY run_id"
    ).all() as { run_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.run_id).toBe('run-A');
    expect(rows[1]!.run_id).toBe('run-B');
  });

  it('same (run_id, card_id, station) triple raises a PK violation', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO active_workers (run_id, card_id, station, worker_id, lease_until) VALUES ('run-X', 'c2', 'brief', 'w1', 9999)"
    ).run();
    expect(() =>
      raw.prepare(
        "INSERT INTO active_workers (run_id, card_id, station, worker_id, lease_until) VALUES ('run-X', 'c2', 'brief', 'w2', 9999)"
      ).run()
    ).toThrow();
  });
});

// AC-4: Card.run_id round-trips through insertCard / getCard.

describe('WI-474 AC-4: Card.run_id round-trip through insertCard / getCard', () => {
  it('insertCard persists run_id and getCard returns it', () => {
    const card = makeCard({ id: 'rc_run', run_id: 'run-test-42' });
    db!.insertCard(card);
    const got = db!.getCard('run-test-42', 'rc_run');
    expect(got).not.toBeNull();
    expect(got!.run_id).toBe('run-test-42');
  });

  it('round-trips all Card fields including run_id', () => {
    const card = makeCard({
      id: 'full_run_card',
      run_id: 'run-fulltrip',
      parent_id: null,
      lane: 'build',
      status: 'working',
      attempt: 1,
      wave: 2,
      rework_count: 3,
      owned_paths: ['src/x.ts'],
    });
    db!.insertCard(card);
    expect(db!.getCard('run-fulltrip', 'full_run_card')).toEqual(card);
  });

  it('getCard returns null for a card id that does not exist under the given run_id', () => {
    const card = makeCard({ id: 'only_in_A', run_id: 'run-A' });
    db!.insertCard(card);
    expect(db!.getCard('run-B', 'only_in_A')).toBeNull();
  });
});

// AC-5: insertRun / getRun raw accessors.

describe('WI-474 AC-5: insertRun / getRun raw accessors', () => {
  it('insertRun persists a run record and getRun returns it', () => {
    db!.insertRun({
      run_id: 'run-persist-1',
      flow: 'studio',
      project_root: '/tmp/studio-project',
      input_fingerprint: 'fp-abc',
      status: 'running',
    });
    const got = db!.getRun('run-persist-1');
    expect(got).not.toBeNull();
    expect(got!.run_id).toBe('run-persist-1');
    expect(got!.flow).toBe('studio');
    expect(got!.project_root).toBe('/tmp/studio-project');
    expect(got!.input_fingerprint).toBe('fp-abc');
    expect(got!.status).toBe('running');
  });

  it('getRun returns null for an unknown run_id', () => {
    expect(db!.getRun('no-such-run')).toBeNull();
  });

  it('insertRun throws on a duplicate run_id (PK violation)', () => {
    db!.insertRun({ run_id: 'run-dup', flow: 'f', input_fingerprint: 'fp', status: 'running' });
    expect(() =>
      db!.insertRun({ run_id: 'run-dup', flow: 'f2', input_fingerprint: 'fp2', status: 'done' })
    ).toThrow();
  });

  it('getRun returns outcome and created_at when present', () => {
    db!.insertRun({
      run_id: 'run-with-outcome',
      flow: 'autocut',
      input_fingerprint: 'fp-xyz',
      status: 'done',
      outcome: 'success',
    });
    const got = db!.getRun('run-with-outcome');
    expect(got!.outcome).toBe('success');
    expect(typeof got!.created_at).toBe('number');
  });
});

describe('schema v6→v7 migration: runs.project_root', () => {
  it('adds project_root to an existing v6 runs table and preserves rows', () => {
    closeConduit();

    const raw = new Database(stateDbPath);
    try {
      raw.exec('DROP TABLE IF EXISTS runs');
      raw.exec(`
        CREATE TABLE runs (
          run_id            TEXT PRIMARY KEY,
          flow              TEXT NOT NULL,
          input_fingerprint TEXT NOT NULL,
          status            TEXT NOT NULL,
          outcome           TEXT,
          created_at        INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      raw
        .prepare(
          `INSERT INTO runs (run_id, flow, input_fingerprint, status)
           VALUES ('legacy-run', 'flow.yaml', 'fp', 'running')`,
        )
        .run();
      raw.exec('PRAGMA user_version = 6');
    } finally {
      raw.close();
    }

    db = openConduitDB({ stateDbPath, journalDbPath });

    const got = db!.getRun('legacy-run');
    expect(got).not.toBeNull();
    expect(got!.project_root).toBeNull();
    expect(got!.flow).toBe('flow.yaml');

    closeConduit();
    const check = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(check, 'runs')).toContain('project_root');
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });
});

describe('schema v7→v8 migration: runs.holder_pid / lease_acquired_at (the original run-lock and busy-retry work)', () => {
  it('opens an existing v7 DB cleanly and adds the lease columns, preserving rows', () => {
    closeConduit();

    const raw = new Database(stateDbPath);
    try {
      raw.exec('DROP TABLE IF EXISTS runs');
      raw.exec(`
        CREATE TABLE runs (
          run_id            TEXT PRIMARY KEY,
          flow              TEXT NOT NULL,
          project_root      TEXT,
          input_fingerprint TEXT NOT NULL,
          status            TEXT NOT NULL,
          outcome           TEXT,
          created_at        INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      raw
        .prepare(
          `INSERT INTO runs (run_id, flow, project_root, input_fingerprint, status)
           VALUES ('v7-run', 'flow.yaml', '/proj', 'fp', 'running')`,
        )
        .run();
      raw.exec('PRAGMA user_version = 7');
    } finally {
      raw.close();
    }

    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();

    const got = db!.getRun('v7-run');
    expect(got).not.toBeNull();
    expect(got!.flow).toBe('flow.yaml');
    expect(got!.project_root).toBe('/proj');

    closeConduit();
    const check = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(check, 'runs')).toContain('holder_pid');
      expect(columnNames(check, 'runs')).toContain('lease_acquired_at');
      const preserved = check
        .query("SELECT run_id, holder_pid, lease_acquired_at FROM runs WHERE run_id = 'v7-run'")
        .get() as { run_id: string; holder_pid: number | null; lease_acquired_at: number | null };
      expect(preserved.holder_pid).toBeNull();
      expect(preserved.lease_acquired_at).toBeNull();
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });
});

// AC-6: v5→v6 migration — backfill existing rows with DEFAULT_RUN_ID, no data loss.

describe('WI-474 AC-6: v5→v6 migration backfills DEFAULT_RUN_ID with no data loss', () => {
  it('migrates a v5 DB without throwing', () => {
    buildV5StateFixture({ seedCards: [{ id: 'pre_card', lane: 'brief', status: 'ready' }] });
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('stamps the migrated DB at SCHEMA_VERSION (10)', () => {
    buildV5StateFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(11);
    } finally {
      check.close();
    }
  });

  it('pre-existing card rows are backfilled with DEFAULT_RUN_ID and no rows are lost', () => {
    buildV5StateFixture({
      seedCards: [
        { id: 'c1', lane: 'brief', status: 'ready' },
        { id: 'c2', lane: 'build', status: 'working' },
      ],
    });
    db = openConduitDB({ stateDbPath, journalDbPath });

    const c1 = db!.getCard(DEFAULT_RUN_ID, 'c1');
    const c2 = db!.getCard(DEFAULT_RUN_ID, 'c2');
    expect(c1).not.toBeNull();
    expect(c1!.run_id).toBe(DEFAULT_RUN_ID);
    expect(c2).not.toBeNull();
    expect(c2!.run_id).toBe(DEFAULT_RUN_ID);
  });

  it('pre-existing outbox rows are backfilled with DEFAULT_RUN_ID and row count is unchanged', () => {
    buildV5StateFixture({
      seedOutbox: [{ idempotency_key: 'key-1' }, { idempotency_key: 'key-2' }],
    });
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT run_id, idempotency_key FROM outbox ORDER BY idempotency_key')
        .all() as { run_id: string; idempotency_key: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.run_id).toBe(DEFAULT_RUN_ID);
      expect(rows[1]!.run_id).toBe(DEFAULT_RUN_ID);
    } finally {
      raw.close();
    }
  });

  it('pre-existing station_outputs rows are backfilled with DEFAULT_RUN_ID and row count is unchanged', () => {
    buildV5StateFixture({
      seedStationOutputs: [
        { card_id: 'c1', station: 'build', attempt: 0, findings_hash: 'h1' },
        { card_id: 'c1', station: 'build', attempt: 1, findings_hash: 'h2' },
      ],
    });
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT run_id FROM station_outputs').all() as { run_id: string }[];
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.run_id).toBe(DEFAULT_RUN_ID);
    } finally {
      raw.close();
    }
  });

  it('pre-existing active_workers rows are backfilled with DEFAULT_RUN_ID and row count is unchanged', () => {
    buildV5StateFixture({
      seedActiveWorkers: [
        { card_id: 'c1', station: 'brief', worker_id: 'w1', lease_until: 9999 },
      ],
    });
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT run_id FROM active_workers').all() as { run_id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.run_id).toBe(DEFAULT_RUN_ID);
    } finally {
      raw.close();
    }
  });
});

// AC-7: migration is idempotent — re-opening a current DB is a no-op.

describe('WI-474 AC-7: migration idempotency', () => {
  it('re-opening an already-current DB does not throw', () => {
    // fresh DB from beforeEach is already current — open it again
    closeConduit();
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('re-opening a current DB leaves SCHEMA_VERSION unchanged at 10', () => {
    closeConduit();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(11);
    } finally {
      check.close();
    }
  });

  it('re-opening does not duplicate run_id columns on any per-run table', () => {
    closeConduit();
    db = openConduitDB({ stateDbPath, journalDbPath });
    closeConduit();

    const rawState = new Database(stateDbPath, { readonly: true });
    const rawJournal = new Database(journalDbPath, { readonly: true });
    try {
      for (const table of ['cards', 'station_outputs', 'outbox', 'active_workers']) {
        const cols = columnNames(rawState, table);
        const runIdCount = cols.filter(c => c === 'run_id').length;
        expect(runIdCount).toBe(1);
      }
      for (const table of ['journal', 'card_log']) {
        const cols = columnNames(rawJournal, table);
        const runIdCount = cols.filter(c => c === 'run_id').length;
        expect(runIdCount).toBe(1);
      }
    } finally {
      rawState.close();
      rawJournal.close();
    }
  });
});

// AC-8: Future version > SCHEMA_VERSION still throws (regression guard).

describe('WI-474 AC-8: future schema version still errors (regression guard)', () => {
  it('throws schema-mismatch when user_version > SCHEMA_VERSION', () => {
    closeConduit();
    const raw = new Database(stateDbPath);
    raw.exec('PRAGMA user_version = 999999');
    raw.close();

    expect(() => openConduitDB({ stateDbPath, journalDbPath })).toThrow(/schema mismatch/i);
  });

  it('leaves the future version stamp untouched after failed open', () => {
    closeConduit();
    const raw = new Database(stateDbPath);
    raw.exec('PRAGMA user_version = 999999');
    raw.close();

    try {
      db = openConduitDB({ stateDbPath, journalDbPath });
    } catch {
      db = null;
    }

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(999999);
    } finally {
      check.close();
    }
  });
});

// AC-9: outbox UNIQUE(run_id, idempotency_key) and station_outputs UNIQUE(run_id, card_id, station, attempt).

describe('WI-474 AC-9: composite UNIQUE constraints on outbox and station_outputs', () => {
  it('outbox admits the same idempotency_key under two different run_ids', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO outbox (run_id, idempotency_key, payload_json) VALUES ($r, 'key-shared', '{}')"
    ).run({ $r: 'run-A' });
    expect(() =>
      raw.prepare(
        "INSERT INTO outbox (run_id, idempotency_key, payload_json) VALUES ($r, 'key-shared', '{}')"
      ).run({ $r: 'run-B' })
    ).not.toThrow();

    const rows = raw.query(
      "SELECT run_id FROM outbox WHERE idempotency_key = 'key-shared' ORDER BY run_id"
    ).all() as { run_id: string }[];
    expect(rows).toHaveLength(2);
  });

  it('outbox rejects the same (run_id, idempotency_key) pair', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO outbox (run_id, idempotency_key, payload_json) VALUES ('run-X', 'key-dup', '{}')"
    ).run();
    expect(() =>
      raw.prepare(
        "INSERT INTO outbox (run_id, idempotency_key, payload_json) VALUES ('run-X', 'key-dup', '{}')"
      ).run()
    ).toThrow();
  });

  it('station_outputs admits the same (card_id, station, attempt) under two different run_ids', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash) VALUES ($r, 'c1', 'build', 0, 'h1')"
    ).run({ $r: 'run-A' });
    expect(() =>
      raw.prepare(
        "INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash) VALUES ($r, 'c1', 'build', 0, 'h1')"
      ).run({ $r: 'run-B' })
    ).not.toThrow();
  });

  it('station_outputs rejects the same (run_id, card_id, station, attempt) tuple', () => {
    const raw = db!.getStateDb();
    raw.prepare(
      "INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash) VALUES ('run-X', 'c2', 'build', 0, 'h1')"
    ).run();
    expect(() =>
      raw.prepare(
        "INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash) VALUES ('run-X', 'c2', 'build', 0, 'h2')"
      ).run()
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// v9→v10 — release_at column on cards for the fan-out cache-warming stagger.
// ---------------------------------------------------------------------------

describe('v9→v10 migration — cards.release_at (fan-out stagger)', () => {
  const hasColumn = (rawDb: Database, table: string, col: string): boolean =>
    (rawDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  const hasIndex = (rawDb: Database, name: string): boolean =>
    (rawDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).some(
      (r) => r.name === name,
    );

  it('a fresh DB has the release_at column and the v10 hot-path indexes', () => {
    closeConduit();
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(hasColumn(raw, 'cards', 'release_at')).toBe(true);
      expect(hasIndex(raw, 'idx_cards_dispatch')).toBe(true);
      expect(hasIndex(raw, 'idx_cards_parent')).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('migrates a v9 DB additively — adds release_at (NULL), preserves rows, stamps v10', () => {
    // Build a v9 state DB: the v6+ cards shape (composite run_id PK) WITHOUT
    // release_at, stamped user_version=9, with one seeded row.
    closeConduit();
    const raw = new Database(stateDbPath);
    raw.exec('DROP TABLE IF EXISTS cards');
    raw.exec(`
      CREATE TABLE cards (
        run_id       TEXT NOT NULL DEFAULT '${DEFAULT_RUN_ID}',
        id           TEXT NOT NULL,
        parent_id    TEXT,
        lane         TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 0,
        wave         INTEGER NOT NULL DEFAULT 0,
        owned_paths  TEXT NOT NULL DEFAULT '[]',
        rework_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, id)
      )
    `);
    raw
      .prepare("INSERT INTO cards (run_id, id, lane, status) VALUES ($run, 'k1', 'work', 'ready')")
      .run({ $run: DEFAULT_RUN_ID });
    raw.exec('PRAGMA user_version = 9');
    raw.close();

    // Open through the migration ladder, then introspect on disk.
    openConduitDB({ stateDbPath, journalDbPath }).close();

    const check = new Database(stateDbPath, { readonly: true });
    try {
      expect(hasColumn(check, 'cards', 'release_at')).toBe(true);
      const row = check.prepare("SELECT id, release_at FROM cards WHERE id = 'k1'").get() as {
        id: string;
        release_at: number | null;
      };
      expect(row.id).toBe('k1'); // row preserved across the additive migration
      expect(row.release_at).toBeNull(); // backfilled NULL — no dispatch gate
      expect(hasIndex(check, 'idx_cards_dispatch')).toBe(true); // hot-path indexes created too
      expect(hasIndex(check, 'idx_cards_parent')).toBe(true);
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION); // stamped to 10
    } finally {
      check.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #5 — migrating a journal that already holds real traffic.
// ---------------------------------------------------------------------------

describe('issue #5 — the cache columns migrate onto an EXISTING journal', () => {
  /**
   * The journal this issue was filed against is a live production instance with
   * a month of rows. An additive migration that only worked on a fresh file
   * would be no fix at all, so build the PRE-#5 table by hand and open over it.
   */
  function seedPreSplitJournal(journalPath: string): void {
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
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    // One row in the shape the issue reports: the whole total in input_tokens,
    // output_tokens 0 on a priced call.
    raw
      .prepare(
        `INSERT INTO journal (run_id, card_id, station, attempt, name,
           model, input_tokens, output_tokens, cost_usd, adapter, usage_unknown)
         VALUES ('default','old','narrate',0,'narrate.harness',
           'claude-opus-4-8', 2000, 0, 5.2, 'claude-headless', 0)`,
      )
      .run();
    raw.close();
  }

  it('adds the columns without disturbing the rows already there', () => {
    const journalPath = join(dir, 'existing-journal.sqlite');
    seedPreSplitJournal(journalPath);

    const migrated = openConduitDB({ stateDbPath: join(dir, 's.sqlite'), journalDbPath: journalPath });
    try {
      const usage = migrated.getStationUsage('old', 'narrate', 0)!;
      // The pre-existing row survives, with its original numbers intact.
      expect(usage['gen_ai.usage.input_tokens']).toBe(2000);
      expect(usage['cost_usd']).toBeCloseTo(5.2);
      // Its cache columns are absent, aggregating to 0 — not an error, and not
      // a fabricated split of a number nobody split at the time.
      expect(usage['gen_ai.usage.cache_read_input_tokens']).toBe(0);
    } finally {
      migrated.close();
    }
  });

  it('counts a pre-split row ONCE in the run total, alongside a post-split one', () => {
    const journalPath = join(dir, 'mixed-journal.sqlite');
    seedPreSplitJournal(journalPath);

    const migrated = openConduitDB({ stateDbPath: join(dir, 's2.sqlite'), journalDbPath: journalPath });
    try {
      migrated.appendJournalSpan({
        runId: 'default', cardId: 'new', station: 'narrate', attempt: 0, name: 'narrate.harness',
        usage: {
          model: 'claude-opus-5', inputTokens: 100, outputTokens: 100, costUsd: 0.1,
          cacheReadInputTokens: 800, cacheCreationInputTokens: 0,
        },
      });

      // 2000 (legacy, whole total in input_tokens) + 1000 (split across four
      // columns). A run spanning the migration boundary still budgets correctly.
      expect(migrated.getRunUsageTotals('default').tokens).toBe(3000);
    } finally {
      migrated.close();
    }
  });
});
