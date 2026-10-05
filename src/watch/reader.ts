/**
 * Read-only journal and state DB reader for `conduit watch` (issue #89).
 *
 * Opens both SQLite files with `readonly: true` and `PRAGMA query_only`, so a
 * write through this module is refused by SQLite itself (PRD §7: the War Room
 * has no write path). It does not go through `openConduitDB`, which migrates
 * and stamps the schema and would therefore write.
 *
 * `poll()` returns the rows appended since the last poll, per table, in id
 * order. Each table has its own cursor (its last id read); there is no
 * sequence shared across the three journal tables (schema gap
 * `cross-table-order`). A cursor moves only after its read succeeded, so a
 * busy or locked database costs a poll, never a row (PRD edge case "journal
 * mid-write / locked"). Columns are discovered with `PRAGMA table_info` and a
 * column an older journal lacks reads as NULL, so a pre-current journal loads.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type {
  CardLogEvent,
  CardSnapshot,
  HarnessEventRow,
  JournalSpanEvent,
  RateLimitWindowReading,
  RunSnapshot,
  StateSnapshot,
  WatchEvent,
} from './events';

export interface WatchReaderPaths {
  stateDbPath: string;
  journalDbPath: string;
}

export interface WatchCursor {
  cardLog: number;
  journal: number;
  harness: number;
}

export interface WatchReader {
  /** The run being watched. */
  readonly runId: string;
  /** Rows appended since the previous poll. Empty when the DB was busy. */
  poll(): WatchEvent[];
  /** The state DB as it is now; null when the read failed (busy). */
  readState(): StateSnapshot | null;
  /** Like `readState`, but says so when the state DB was busy instead of returning null. */
  readStateOrBusy(): { busy: true } | { busy: false; snapshot: StateSnapshot };
  /** The per-table position of the last successful poll. */
  cursor(): WatchCursor;
  close(): void;
}

/** The state DB stayed busy or locked for the whole wait. */
export class WatchBusyError extends Error {
  constructor(path: string) {
    super(`state database is busy: ${path}`);
    this.name = 'WatchBusyError';
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 2000;

/** Open one database file read-only, refusing to create it. */
export function openReadOnly(path: string, label: string, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS): Database {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
  const db = new Database(path, { readonly: true });
  db.exec('PRAGMA query_only = 1');
  // The kernel holds the write lock in short transactions; wait for it rather
  // than fail the read.
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  return db;
}

/** The column names of `table`, or an empty set when the table does not exist. */
function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** `col` when the table has it, else `NULL AS col`. */
function selectList(have: Set<string>, wanted: readonly string[]): string {
  return wanted.map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(', ');
}

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg);
}

/**
 * Runs `fn` inside one read transaction so every query in it sees one snapshot.
 * The transaction is always closed. A failure from `fn` or from COMMIT is
 * rethrown as is; a ROLLBACK that itself fails never replaces it.
 */
function inReadTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  const rollback = (): void => {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing is open to roll back, or the handle is unusable: the original error is the one to report.
    }
  };
  let result: T;
  try {
    result = fn();
  } catch (err) {
    rollback();
    throw err;
  }
  try {
    db.exec('COMMIT');
  } catch (err) {
    rollback();
    throw err;
  }
  return result;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

function parseWindows(raw: unknown): RateLimitWindowReading[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const out: RateLimitWindowReading[] = [];
    for (const w of value) {
      if (w === null || typeof w !== 'object') continue;
      const rec = w as Record<string, unknown>;
      if (typeof rec.name !== 'string' || typeof rec.utilization !== 'number') continue;
      out.push({
        name: rec.name,
        utilization: rec.utilization,
        resetsAtMs: typeof rec.resetsAtMs === 'number' ? rec.resetsAtMs : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const CARD_LOG_COLS = [
  'id', 'card_id', 'station', 'attempt', 'kind', 'source_lane', 'dest_lane',
  'reason_class', 'verdict', 'findings_json', 'return_to', 'reason',
] as const;

const JOURNAL_COLS = [
  'id', 'card_id', 'station', 'attempt', 'name', 'attributes_json', 'input_tokens',
  'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cost_usd',
  'usage_unknown', 'duration_ms', 'created_at',
] as const;

const HARNESS_COLS = [
  'id', 'card_id', 'station', 'attempt', 'invocation_id', 'kind', 'at_ms', 'tool_name',
  'path', 'exit_code', 'is_error', 'phase', 'rate_limit_windows_json',
] as const;

type Row = Record<string, unknown>;

/** Convert one card_log row. Exported for the replay tests. */
export function cardLogEventFromRow(row: Row): CardLogEvent {
  const base = {
    source: 'card_log' as const,
    id: num(row.id) ?? 0,
    cardId: str(row.card_id) ?? '',
    station: str(row.station) ?? '',
    attempt: num(row.attempt) ?? 0,
  };
  switch (row.kind) {
    case 'entered_lane':
      return {
        ...base,
        kind: 'entered_lane',
        sourceLane: str(row.source_lane),
        destLane: str(row.dest_lane),
        reasonClass: str(row.reason_class),
      };
    case 'gate_verdict':
      return {
        ...base,
        kind: 'gate_verdict',
        verdict: str(row.verdict),
        findings: parseStringArray(row.findings_json),
        returnTo: str(row.return_to),
      };
    case 'terminal':
      return { ...base, kind: 'terminal', reason: str(row.reason) };
    case 'skip':
      return { ...base, kind: 'skip', reason: str(row.reason) };
    default:
      return { ...base, kind: 'other', rawKind: String(row.kind) };
  }
}

/** Convert one journal span row. */
export function journalEventFromRow(row: Row): JournalSpanEvent {
  const parts = [row.input_tokens, row.output_tokens, row.cache_read_input_tokens, row.cache_creation_input_tokens]
    .map(num)
    .filter((n): n is number => n !== null);
  return {
    source: 'journal',
    id: num(row.id) ?? 0,
    cardId: str(row.card_id) ?? '',
    station: str(row.station) ?? '',
    attempt: num(row.attempt) ?? 0,
    name: str(row.name) ?? '',
    createdAt: num(row.created_at),
    tokens: parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0),
    costUsd: num(row.cost_usd),
    usageUnknown: row.usage_unknown === 1,
    durationMs: num(row.duration_ms),
    attributes: parseJsonObject(row.attributes_json),
  };
}

/** Convert one harness_events row. */
export function harnessEventFromRow(row: Row): HarnessEventRow {
  return {
    source: 'harness',
    id: num(row.id) ?? 0,
    cardId: str(row.card_id) ?? '',
    station: str(row.station) ?? '',
    attempt: num(row.attempt) ?? 0,
    kind: str(row.kind) ?? '',
    invocationId: str(row.invocation_id),
    atMs: num(row.at_ms),
    toolName: str(row.tool_name),
    path: str(row.path),
    exitCode: num(row.exit_code),
    isError: row.is_error === null || row.is_error === undefined ? null : row.is_error === 1,
    phase: str(row.phase),
    rateLimitWindows: parseWindows(row.rate_limit_windows_json),
  };
}

/**
 * The newest run in the state DB, or null when it records none. Throws
 * `WatchBusyError` when the DB stayed locked, so a busy DB is never reported
 * as "no runs".
 */
export function newestRunId(stateDbPath: string, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS): string | null {
  const db = openReadOnly(stateDbPath, 'state database', busyTimeoutMs);
  try {
    if (columnsOf(db, 'runs').size === 0) return null;
    const row = db
      .prepare('SELECT run_id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as { run_id: string } | null;
    return row?.run_id ?? null;
  } catch (err) {
    if (isBusy(err)) throw new WatchBusyError(stateDbPath);
    throw err;
  } finally {
    db.close();
  }
}

export function openWatchReader(paths: WatchReaderPaths, runId: string): WatchReader {
  const stateDb = openReadOnly(paths.stateDbPath, 'state database');
  let journalDb: Database;
  try {
    journalDb = openReadOnly(paths.journalDbPath, 'journal database');
  } catch (err) {
    stateDb.close();
    throw err;
  }

  const cursor: WatchCursor = { cardLog: 0, journal: 0, harness: 0 };
  const readStateSnapshot = createStateSnapshotReader(stateDb, runId);

  // Built lazily and rebuilt when a table appears: a journal opened before the
  // kernel created harness_events gains it later.
  const queries = new Map<string, ReturnType<Database['prepare']> | null>();
  const follow = (table: string, cols: readonly string[]): ReturnType<Database['prepare']> | null => {
    const cached = queries.get(table);
    if (cached) return cached;
    const have = columnsOf(journalDb, table);
    if (have.size === 0) return null;
    const runFilter = have.has('run_id') ? 'run_id = $run AND ' : '';
    const stmt = journalDb.prepare(
      `SELECT ${selectList(have, cols)} FROM ${table} WHERE ${runFilter}id > $after ORDER BY id ASC`,
    );
    queries.set(table, stmt);
    return stmt;
  };

  const readTable = (table: string, cols: readonly string[], after: number): Row[] => {
    const stmt = follow(table, cols);
    if (stmt === null) return [];
    return stmt.all({ $run: runId, $after: after }) as Row[];
  };

  return {
    runId,
    poll(): WatchEvent[] {
      let cardLogRows: Row[];
      let journalRows: Row[];
      let harnessRows: Row[];
      try {
        // One read transaction, so the three tables come from one snapshot.
        [cardLogRows, journalRows, harnessRows] = inReadTransaction(journalDb, () => [
          readTable('card_log', CARD_LOG_COLS, cursor.cardLog),
          readTable('journal', JOURNAL_COLS, cursor.journal),
          readTable('harness_events', HARNESS_COLS, cursor.harness),
        ]);
      } catch (err) {
        if (isBusy(err)) return [];
        throw err;
      }
      const events: WatchEvent[] = [
        ...cardLogRows.map(cardLogEventFromRow),
        ...journalRows.map(journalEventFromRow),
        ...harnessRows.map(harnessEventFromRow),
      ];
      if (cardLogRows.length > 0) cursor.cardLog = num(cardLogRows[cardLogRows.length - 1]!.id) ?? cursor.cardLog;
      if (journalRows.length > 0) cursor.journal = num(journalRows[journalRows.length - 1]!.id) ?? cursor.journal;
      if (harnessRows.length > 0) cursor.harness = num(harnessRows[harnessRows.length - 1]!.id) ?? cursor.harness;
      return events;
    },

    readState(): StateSnapshot | null {
      const result = this.readStateOrBusy();
      return result.busy ? null : result.snapshot;
    },

    readStateOrBusy(): { busy: true } | { busy: false; snapshot: StateSnapshot } {
      try {
        return { busy: false, snapshot: readStateSnapshot() };
      } catch (err) {
        if (isBusy(err)) return { busy: true };
        throw err;
      }
    },

    cursor(): WatchCursor {
      return { ...cursor };
    },

    close(): void {
      stateDb.close();
      journalDb.close();
    },
  };
}

type Statement = ReturnType<Database['prepare']>;

/**
 * Reads the state DB for one run. A table's columns and the statement built
 * from them are resolved once the table has columns. An empty column set means
 * the table does not exist yet (the kernel may create it after the watcher
 * starts), so it is never cached and the next read looks again.
 */
function createStateSnapshotReader(stateDb: Database, runId: string): () => StateSnapshot {
  const resolved = new Map<string, Statement>();
  const statement = (table: string, build: (have: Set<string>) => string): Statement | null => {
    const cached = resolved.get(table);
    if (cached) return cached;
    const have = columnsOf(stateDb, table);
    if (have.size === 0) return null;
    const stmt = stateDb.prepare(build(have));
    resolved.set(table, stmt);
    return stmt;
  };

  // runs, active_workers and cards are read in one transaction: a card that
  // finishes between the reads would otherwise show as working with no worker.
  return (): StateSnapshot => inReadTransaction(stateDb, readSnapshot);

  function readSnapshot(): StateSnapshot {
    let run: RunSnapshot | null = null;
    const runQuery = statement(
      'runs',
      (have) => `SELECT ${selectList(have, ['run_id', 'flow', 'status', 'outcome', 'created_at'])} FROM runs WHERE run_id = $run`,
    );
    const runRow = runQuery?.get({ $run: runId }) as Row | null | undefined;
    if (runRow) {
      run = {
        runId,
        flow: str(runRow.flow) ?? '',
        status: str(runRow.status) ?? '',
        outcome: str(runRow.outcome),
        createdAt: num(runRow.created_at) ?? 0,
      };
    }

    const cardQuery = statement(
      'cards',
      (have) => `SELECT ${selectList(have, ['id', 'parent_id', 'lane', 'status', 'attempt', 'wave', 'rework_count', 'owned_paths', 'release_at'])}
       FROM cards ${have.has('run_id') ? 'WHERE run_id = $run' : ''} ORDER BY rowid ASC`,
    );
    if (cardQuery === null) return { cards: [], run };
    const workerQuery = statement(
      'active_workers',
      (have) => `SELECT card_id, started_at FROM active_workers ${have.has('run_id') ? 'WHERE run_id = $run' : ''}`,
    );
    const startedAt = new Map<string, number>();
    for (const w of (workerQuery?.all({ $run: runId }) ?? []) as Row[]) {
      const id = str(w.card_id);
      const at = num(w.started_at);
      if (id !== null && at !== null) startedAt.set(id, at);
    }
    const rows = cardQuery.all({ $run: runId }) as Row[];
    const cards: CardSnapshot[] = rows.map((r) => {
      const id = str(r.id) ?? '';
      return {
        id,
        parentId: str(r.parent_id),
        lane: str(r.lane) ?? '',
        status: str(r.status) ?? '',
        attempt: num(r.attempt) ?? 0,
        wave: num(r.wave) ?? 0,
        reworkCount: num(r.rework_count),
        ownedPaths: parseStringArray(r.owned_paths) ?? [],
        releaseAt: num(r.release_at),
        workerStartedAt: startedAt.get(id) ?? null,
      };
    });
    return { cards, run };
  }
}
