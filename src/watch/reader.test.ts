/**
 * The War Room reader and the core guarantees of the shared projection
 * (issue #89): the DBs are opened read-only, new rows are followed by id,
 * replay equals live, a burst written in one tick folds without losing rows,
 * and a journal that predates current columns loads.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { emptyContext } from './context';
import type { WatchEvent } from './events';
import { deriveView, emptyFold, foldEvents, replay, type WatchContext } from './projection';
import { newestRunId, openReadOnly, openWatchReader, WatchBusyError, type WatchReader } from './reader';
import { card, createWatchFixture, setSpanTime, type WatchFixture } from './test-fixture';

const NOW = 1_000_600;

const context: WatchContext = {
  ...emptyContext(),
  stations: ['draft', 'review'],
  stationKinds: { draft: 'harness', review: 'transform' },
  wallClockSec: 3600,
  maxTokens: 100_000,
  livenessSec: 600,
  reworkCaps: { review: 3 },
  maxAttempts: 4,
  flowLoaded: true,
};

let fx: WatchFixture;
let reader: WatchReader | null = null;

beforeEach(() => {
  fx = createWatchFixture();
});

afterEach(() => {
  reader?.close();
  reader = null;
  fx.cleanup();
});

const open = (): WatchReader => {
  reader = openWatchReader({ stateDbPath: fx.stateDbPath, journalDbPath: fx.journalDbPath }, fx.runId);
  return reader;
};

/** Write one step of a run across all three journal tables. */
function writeStep(i: number): void {
  const cardId = `c${i % 3}`;
  fx.db.appendCardLog({
    runId: fx.runId, cardId, station: 'draft', attempt: i, kind: 'entered_lane',
    sourceLane: 'intake', destLane: i % 2 === 0 ? 'draft' : 'review', reasonClass: i % 4 === 3 ? 'rework' : 'forward',
  });
  fx.db.appendJournalSpan({
    runId: fx.runId, cardId, station: 'draft', attempt: i, name: 'draft.harness',
    usage: { model: 'm', inputTokens: 10 * i, outputTokens: 5, costUsd: 0.01 },
  });
  setSpanTime(fx, 1_000_000 + i * 10);
  fx.db.appendHarnessEvent({
    runId: fx.runId, cardId, station: 'draft', attempt: i, invocationId: `inv-${i}`, seq: 0,
    kind: 'tool-input-available', atMs: (1_000_000 + i * 10 + 5) * 1000, toolName: 'Read', path: `f${i}.ts`,
  });
}

function writeNothingAndRead(r: WatchReader): void {
  r.poll();
  r.readState();
  r.poll();
}

describe('read-only access', () => {
  test('a connection opened by the reader refuses writes', () => {
    const db = openReadOnly(fx.journalDbPath, 'journal database');
    try {
      expect(() => db.exec("INSERT INTO card_log (card_id, station, attempt, kind) VALUES ('x', 's', 0, 'skip')")).toThrow();
    } finally {
      db.close();
    }
  });

  test('a missing database file is an error, not a new empty file', () => {
    expect(() => openReadOnly(join(fx.dir, 'nope.sqlite'), 'journal database')).toThrow(/not found/);
  });

  test('watching leaves the database and WAL files byte-identical', async () => {
    writeStep(0);
    fx.db.insertCard(card(fx.runId, 'c0'));
    fx.db.close();
    Bun.gc(true);
    // Settle the kernel's WAL first, so only the reader could change a byte.
    for (const path of [fx.stateDbPath, fx.journalDbPath]) {
      const w = new Database(path);
      w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      w.close();
    }
    // The -shm index is excluded: every reader, read-only or not, records its
    // read mark there. SQLite also creates an empty -wal for any reader of a
    // WAL database, so a missing WAL and an empty one compare equal.
    const files = [fx.stateDbPath, fx.journalDbPath, `${fx.stateDbPath}-wal`, `${fx.journalDbPath}-wal`];
    const bytes = () =>
      Promise.all(files.map(async (f) => ((await Bun.file(f).exists()) ? Bun.file(f).bytes() : new Uint8Array())));
    const before = await bytes();
    const r = open();
    writeNothingAndRead(r);
    r.close();
    reader = null;
    expect(await bytes()).toEqual(before);
  });

  test('newestRunId picks the latest run', () => {
    fx.db.insertRun({ run_id: 'run-b', flow: 'f.yaml', input_fingerprint: 'fp', status: 'running' });
    fx.db.getStateDb().prepare('UPDATE runs SET created_at = ? WHERE run_id = ?').run(2_000_000, 'run-b');
    expect(newestRunId(fx.stateDbPath)).toBe('run-b');
  });
});

describe('following the journal', () => {
  test('each poll returns only the rows appended since the last one', () => {
    const r = open();
    expect(r.poll()).toEqual([]);
    writeStep(0);
    const first = r.poll();
    expect(first.map((e) => e.source)).toEqual(['card_log', 'journal', 'harness']);
    expect(r.poll()).toEqual([]);
    writeStep(1);
    writeStep(2);
    const second = r.poll();
    expect(second).toHaveLength(6);
    expect(r.cursor()).toEqual({ cardLog: 3, journal: 3, harness: 3 });
  });

  test('rows of another run are not read', () => {
    fx.db.appendCardLog({
      runId: 'other', cardId: 'x', station: 'draft', attempt: 0, kind: 'terminal', reason: 'done',
    });
    expect(open().poll()).toEqual([]);
  });

  test('the state snapshot carries cards, the run row and worker start times', () => {
    fx.db.insertCard(card(fx.runId, 'p', { lane: 'draft', status: 'awaiting_children' }));
    fx.db.insertCard(card(fx.runId, 'k', { parent_id: 'p', lane: 'review', status: 'working', owned_paths: ['out/k'] }));
    fx.db.getStateDb()
      .prepare('INSERT INTO active_workers (run_id, card_id, station, worker_id, started_at, lease_until) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fx.runId, 'k', 'review', 'w1', 1_000_100, 1_000_900);
    const snap = open().readState()!;
    expect(snap.run).toMatchObject({ runId: fx.runId, status: 'running', createdAt: 1_000_000 });
    expect(snap.cards.map((c) => c.id)).toEqual(['p', 'k']);
    expect(snap.cards[1]).toMatchObject({ parentId: 'p', ownedPaths: ['out/k'], workerStartedAt: 1_000_100 });
  });
});

describe('replay equals live', () => {
  test('the live fold of interleaved polls equals a restart and a replay at the head', () => {
    for (const id of ['c0', 'c1', 'c2']) fx.db.insertCard(card(fx.runId, id));
    const live = open();
    let liveFold = emptyFold();
    const recorded: WatchEvent[] = [];
    for (let i = 0; i < 12; i++) {
      writeStep(i);
      // Poll after some steps only, so batches straddle table boundaries.
      if (i % 3 !== 1) {
        const batch = live.poll();
        recorded.push(...batch);
        liveFold = foldEvents(liveFold, batch);
      }
    }
    const tail = live.poll();
    recorded.push(...tail);
    liveFold = foldEvents(liveFold, tail);
    const snapshot = live.readState();
    const input = { runId: fx.runId, context, snapshot, nowSec: NOW };

    // A restart reads every row in one poll, table by table: a different
    // interleaving of the same rows.
    const restart = openWatchReader({ stateDbPath: fx.stateDbPath, journalDbPath: fx.journalDbPath }, fx.runId);
    const restartFold = foldEvents(emptyFold(), restart.poll());
    restart.close();

    const liveView = deriveView(liveFold, { ...input, mode: 'live' });
    expect(deriveView(restartFold, { ...input, mode: 'live' })).toEqual(liveView);
    expect(replay(recorded, recorded.length, input)).toEqual(deriveView(liveFold, { ...input, mode: 'replay' }));
    expect(liveView.eventCount).toBe(36);
  });

  test('replay to an earlier position rolls back the header and the rows', () => {
    for (let i = 0; i < 6; i++) writeStep(i);
    const events = open().poll();
    const input = { runId: fx.runId, context, snapshot: reader!.readState(), nowSec: NOW };
    // The 6 card_log rows, then the first 3 spans.
    const early = replay(events, 9, input);
    const head = replay(events, events.length, input);
    expect(early.eventCount).toBe(9);
    expect(early.tokens.fraction).toBeLessThan(head.tokens.fraction!);
    expect(early.elapsedSec).toBeLessThan(head.elapsedSec!);
  });
});

describe('a burst of rows written in one tick', () => {
  test('folds to the same view as the same rows folded one at a time', () => {
    const r = open();
    const state = fx.db.getStateDb();
    // One transaction per DB, as a tick writes them.
    const journal = new Database(fx.journalDbPath);
    journal.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 50; i++) {
      journal
        .prepare(
          `INSERT INTO card_log (run_id, card_id, station, attempt, kind, source_lane, dest_lane, reason_class)
           VALUES (?, ?, 'review', ?, 'entered_lane', 'review', ?, ?)`,
        )
        .run(fx.runId, `c${i % 5}`, i, i % 2 === 0 ? 'draft' : 'review', i % 2 === 0 ? 'rework' : 'forward');
      journal
        .prepare(
          `INSERT INTO journal (run_id, card_id, station, attempt, name, input_tokens, output_tokens, cost_usd, created_at)
           VALUES (?, ?, 'review', ?, 'review.transform', 100, 10, 0.5, ?)`,
        )
        .run(fx.runId, `c${i % 5}`, i, 1_000_000 + i);
    }
    journal.exec('COMMIT');
    journal.close();
    state.exec('SELECT 1');

    const burst = r.poll();
    expect(burst).toHaveLength(100);
    const once = foldEvents(emptyFold(), burst);
    let stepwise = emptyFold();
    for (const ev of burst) stepwise = foldEvents(stepwise, [ev]);
    expect(once).toEqual(stepwise);
    expect(once.runTokens).toBe(50 * 110);
    expect(once.cards['c0']!.reworksByGate['review']).toBe(5);
    const input = { runId: fx.runId, context, snapshot: r.readState(), nowSec: NOW, mode: 'live' as const };
    expect(deriveView(once, input)).toEqual(deriveView(stepwise, input));
  });

  test('folding never mutates the fold it was given', () => {
    writeStep(0);
    const events = open().poll();
    const base = foldEvents(emptyFold(), events.slice(0, 1));
    const snapshot = JSON.stringify(base);
    foldEvents(base, events.slice(1));
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('older journals', () => {
  test('a journal without the newer columns or harness_events loads and replays', () => {
    const dir = fx.dir;
    const journalDbPath = join(dir, 'old.journal.sqlite');
    const old = new Database(journalDbPath);
    old.exec(`
      CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, station TEXT NOT NULL,
        attempt INTEGER NOT NULL, name TEXT NOT NULL, attributes_json TEXT NOT NULL DEFAULT '{}',
        input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL);
      CREATE TABLE card_log (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, station TEXT NOT NULL,
        attempt INTEGER NOT NULL, kind TEXT NOT NULL, source_lane TEXT, dest_lane TEXT, reason_class TEXT,
        verdict TEXT, findings_json TEXT, return_to TEXT, reason TEXT);
      INSERT INTO card_log (card_id, station, attempt, kind, dest_lane) VALUES ('c0', 'draft', 0, 'entered_lane', 'draft');
      INSERT INTO card_log (card_id, station, attempt, kind, findings_json) VALUES ('c0', 'review', 0, 'gate_verdict', 'not json');
      INSERT INTO card_log (card_id, station, attempt, kind) VALUES ('c0', 'review', 0, 'some_future_kind');
      INSERT INTO journal (card_id, station, attempt, name, attributes_json) VALUES ('c0', 'draft', 0, 'draft.transform', '{');
    `);
    old.close();
    const r = openWatchReader({ stateDbPath: fx.stateDbPath, journalDbPath }, fx.runId);
    try {
      const events = r.poll();
      expect(events).toHaveLength(4);
      const view = replay(events, events.length, { runId: fx.runId, context: emptyContext(), snapshot: null, nowSec: NOW });
      expect(view.rows.map((row) => row.id)).toEqual(['c0']);
      expect(view.elapsedSec).toBeNull();
      expect(view.wall.text).toBe('not recorded');
      expect(view.watchdog.text).toBe('not recorded');
      expect(view.gaps).toContain('flow-at-run');
    } finally {
      r.close();
    }
  });

  test('events with every optional field missing fold without throwing', () => {
    const bare: WatchEvent[] = [
      { source: 'card_log', id: 1, cardId: 'x', station: '', attempt: 0, kind: 'entered_lane', sourceLane: null, destLane: null, reasonClass: null },
      { source: 'card_log', id: 2, cardId: 'x', station: '', attempt: 0, kind: 'gate_verdict', verdict: null, findings: null, returnTo: null },
      { source: 'card_log', id: 3, cardId: 'x', station: '', attempt: 0, kind: 'terminal', reason: null },
      {
        source: 'journal', id: 1, cardId: 'x', station: '', attempt: 0, name: 'hitl.held_at', createdAt: null,
        tokens: null, costUsd: null, usageUnknown: false, durationMs: null, attributes: {},
      },
      {
        source: 'harness', id: 1, cardId: 'x', station: '', attempt: 0, kind: 'rate-limit', invocationId: null, atMs: null,
        toolName: null, path: null, exitCode: null, isError: null, phase: null, rateLimitWindows: null,
      },
    ];
    for (let n = 0; n <= bare.length; n++) {
      expect(() => replay(bare, n, { runId: 'r', context: emptyContext(), snapshot: null, nowSec: NOW })).not.toThrow();
    }
  });
});

describe('a busy state database', () => {
  /** A rollback-journal DB (WAL readers are never blocked) with an exclusive writer holding it. */
  function lockedStateDb(): { path: string; release(): void } {
    const path = join(fx.dir, 'locked.sqlite');
    const setup = new Database(path);
    setup.exec(`CREATE TABLE runs (run_id TEXT, created_at INTEGER); INSERT INTO runs VALUES ('r1', 1);`);
    setup.close();
    const writer = new Database(path);
    writer.exec('BEGIN EXCLUSIVE');
    return {
      path,
      release() {
        writer.exec('ROLLBACK');
        writer.close();
      },
    };
  }

  test('newestRunId throws WatchBusyError rather than a raw SQLite error', () => {
    const locked = lockedStateDb();
    try {
      expect(() => newestRunId(locked.path, 1)).toThrow(WatchBusyError);
    } finally {
      locked.release();
    }
  });

  test('newestRunId reads the run once the lock is released', () => {
    const locked = lockedStateDb();
    locked.release();
    expect(newestRunId(locked.path, 1)).toBe('r1');
  });

  test('readStateOrBusy returns the snapshot when the DB is readable', () => {
    const r = open();
    const result = r.readStateOrBusy();
    expect(result.busy).toBe(false);
    if (!result.busy) expect(result.snapshot.run?.runId).toBe(fx.runId);
  });
});

describe('state snapshot column discovery', () => {
  test('tables created after the reader opened are picked up', () => {
    const stateDbPath = join(fx.dir, 'late.sqlite');
    new Database(stateDbPath).close();
    const r = openWatchReader({ stateDbPath, journalDbPath: fx.journalDbPath }, 'late');
    try {
      expect(r.readState()).toEqual({ cards: [], run: null });
      const kernel = new Database(stateDbPath);
      kernel.exec(`
        CREATE TABLE runs (run_id TEXT, flow TEXT, status TEXT, outcome TEXT, created_at INTEGER);
        CREATE TABLE cards (run_id TEXT, id TEXT, lane TEXT, status TEXT);
        INSERT INTO runs VALUES ('late', 'f.yaml', 'running', NULL, 5);
        INSERT INTO cards VALUES ('late', 'c1', 'draft', 'ready');
      `);
      kernel.close();
      const snap = r.readState()!;
      expect(snap.run?.flow).toBe('f.yaml');
      expect(snap.cards.map((c) => c.id)).toEqual(['c1']);
    } finally {
      r.close();
    }
  });

  test('table_info is not re-run once a table has columns', () => {
    const r = open();
    r.readState();
    const prepare = spyOn(Database.prototype, 'prepare');
    try {
      const tableInfo = (): number => prepare.mock.calls.filter(([sql]) => String(sql).includes('table_info')).length;
      // Control: the spy does see a PRAGMA table_info prepare.
      fx.db.getStateDb().prepare('PRAGMA table_info(runs)').all();
      expect(tableInfo()).toBe(1);
      r.readState();
      r.readState();
      expect(tableInfo()).toBe(1);
    } finally {
      prepare.mockRestore();
    }
  });
});

describe('state snapshot consistency', () => {
  /**
   * Runs `fn` while `onWorkerRead` fires right after each `active_workers` read.
   * bun:sqlite defines `all` on each statement instance, so the hook wraps the
   * statement `prepare` returns. Use it on a reader that has not read state yet,
   * so the statement is prepared (and wrapped) inside `fn`.
   */
  function withWorkerReadHook<T>(onWorkerRead: () => void, fn: () => T): T {
    const realPrepare = Database.prototype.prepare;
    const spy = spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, ...args: Parameters<Database['prepare']>) {
      const stmt = realPrepare.apply(this, args);
      if (String(args[0]).includes('FROM active_workers')) {
        const realAll = stmt.all.bind(stmt);
        stmt.all = ((...a: unknown[]) => {
          const out = (realAll as (...x: unknown[]) => unknown)(...a);
          onWorkerRead();
          return out;
        }) as typeof stmt.all;
      }
      return stmt;
    } as Database['prepare']);
    try {
      return fn();
    } finally {
      spy.mockRestore();
    }
  }

  test('cards and active_workers come from one snapshot even if a writer commits between the reads', () => {
    fx.db.insertCard(card(fx.runId, 'k', { lane: 'review', status: 'working' }));
    fx.db.getStateDb()
      .prepare('INSERT INTO active_workers (run_id, card_id, station, worker_id, started_at, lease_until) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fx.runId, 'k', 'review', 'w1', 1_000_100, 1_000_900);
    const r = open();
    const writer = new Database(fx.stateDbPath);
    let injected = false;
    try {
      const snap = withWorkerReadHook(
        () => {
          if (injected) return;
          injected = true;
          // The worker finishes between the active_workers read and the cards read.
          writer.exec(`UPDATE cards SET status = 'done', lane = 'done' WHERE id = 'k'; DELETE FROM active_workers WHERE card_id = 'k';`);
        },
        () => r.readState()!,
      );
      expect(injected).toBe(true);
      expect(snap.cards[0]).toMatchObject({ id: 'k', status: 'working', workerStartedAt: 1_000_100 });
    } finally {
      writer.close();
    }
    // The next snapshot sees the committed change.
    expect(r.readState()!.cards[0]).toMatchObject({ status: 'done', workerStartedAt: null });
  });

  test('a busy error mid-snapshot leaves no open transaction and the next read succeeds', () => {
    const r = open();
    let armed = true;
    const result = withWorkerReadHook(
      () => {
        if (!armed) return;
        armed = false;
        throw new Error('SQLITE_BUSY: database is locked');
      },
      () => r.readStateOrBusy(),
    );
    expect(result).toEqual({ busy: true });
    // A leaked transaction would make the next BEGIN fail with "within a transaction".
    expect(r.readStateOrBusy().busy).toBe(false);
  });

  test('a non-busy error mid-snapshot propagates and still closes the transaction', () => {
    const r = open();
    let armed = true;
    withWorkerReadHook(
      () => {
        if (!armed) return;
        armed = false;
        throw new Error('boom');
      },
      () => expect(() => r.readStateOrBusy()).toThrow('boom'),
    );
    expect(r.readStateOrBusy().busy).toBe(false);
  });
});
