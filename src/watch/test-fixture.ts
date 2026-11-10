/**
 * Test fixture for the War Room: a real state DB and journal written through
 * the kernel's own writers (`openConduitDB`), so the reader is tested against
 * the schema the kernel actually produces. Tests only.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { Card } from '../types/kernel';

export interface WatchFixture {
  dir: string;
  stateDbPath: string;
  journalDbPath: string;
  db: ConduitDB;
  runId: string;
  cleanup(): void;
}

export function createWatchFixture(runId = 'run-a', createdAt = 1_000_000): WatchFixture {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-watch-'));
  const stateDbPath = join(dir, 'conduit.sqlite');
  const journalDbPath = join(dir, 'conduit.journal.sqlite');
  const db = openConduitDB({ stateDbPath, journalDbPath });
  db.insertRun({ run_id: runId, flow: join(dir, 'flow.yaml'), input_fingerprint: 'fp', status: 'running' });
  db.getStateDb().prepare('UPDATE runs SET created_at = ? WHERE run_id = ?').run(createdAt, runId);
  return {
    dir,
    stateDbPath,
    journalDbPath,
    db,
    runId,
    cleanup() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function card(runId: string, id: string, over: Partial<Card> = {}): Card {
  return {
    run_id: runId,
    id,
    parent_id: null,
    lane: 'draft',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    ...over,
  };
}

/** Stamp a journal span's created_at, which the writer sets from the clock. */
export function setSpanTime(fixture: WatchFixture, createdAt: number): void {
  const journal = new Database(fixture.journalDbPath);
  try {
    journal.prepare('UPDATE journal SET created_at = ? WHERE id = (SELECT MAX(id) FROM journal)').run(createdAt);
  } finally {
    journal.close();
  }
}
