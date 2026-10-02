/**
 * `conduit watch` argument handling and the live session (issue #89). The
 * renderer itself is covered by app.test.tsx; these cover every exit that
 * happens before it starts, and the poll-fold-derive loop behind it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { main, type CliDeps } from '../cli/main';
import type { ConduitDB } from '../persistence/db';
import { emptyContext } from './context';
import { createLiveSession } from './live';
import { openWatchReader } from './reader';
import { card, createWatchFixture, type WatchFixture } from './test-fixture';

let fx: WatchFixture;
const saved = { state: process.env.CONDUIT_STATE_DB, journal: process.env.CONDUIT_JOURNAL_DB };

beforeEach(() => {
  fx = createWatchFixture();
  process.env.CONDUIT_STATE_DB = fx.stateDbPath;
  process.env.CONDUIT_JOURNAL_DB = fx.journalDbPath;
});

afterEach(() => {
  fx.cleanup();
  for (const [key, value] of [['CONDUIT_STATE_DB', saved.state], ['CONDUIT_JOURNAL_DB', saved.journal]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** CliDeps whose db throws on any use: watch must never read through it. */
function readOnlyDeps(): { deps: CliDeps; errors: string[] } {
  const errors: string[] = [];
  const db = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'close') return () => {};
      throw new Error(`watch touched deps.db (.${String(prop)})`);
    },
  }) as unknown as ConduitDB;
  const deps = {
    io: { out: () => {}, err: (line: string) => errors.push(line) },
    now: () => 0,
    db,
    adapter: { call: async () => { throw new Error('no adapter'); } },
    runEngine: async () => { throw new Error('no engine'); },
    prereqs: [],
  } as unknown as CliDeps;
  return { deps, errors };
}

describe('conduit watch exits before rendering', () => {
  test('an invalid run id', async () => {
    const { deps, errors } = readOnlyDeps();
    expect(await main(['watch', '--run', 'bad id!'], deps)).toBe(1);
    expect(errors[0]).toContain('invalid run-id');
  });

  test('--run with no value', async () => {
    const { deps, errors } = readOnlyDeps();
    expect(await main(['watch', '--run'], deps)).toBe(1);
    expect(errors).toEqual(['error: --run needs a run id. usage: conduit watch [--run <id>]']);
  });

  test('an unknown argument', async () => {
    const { deps, errors } = readOnlyDeps();
    expect(await main(['watch', '--follow'], deps)).toBe(1);
    expect(errors[0]).toContain('usage: conduit watch [--run <id>]');
  });

  test('a run the state DB does not record', async () => {
    const { deps, errors } = readOnlyDeps();
    expect(await main(['watch', '--run', 'nope'], deps)).toBe(1);
    expect(errors[0]).toContain('run "nope" not found');
  });

  test('a missing journal file', async () => {
    process.env.CONDUIT_JOURNAL_DB = join(fx.dir, 'missing.sqlite');
    const { deps, errors } = readOnlyDeps();
    expect(await main(['watch', '--run', fx.runId], deps)).toBe(1);
    expect(errors[0]).toContain('journal database not found');
  });
});

describe('live session', () => {
  test('each tick folds the new rows and notifies the screen', () => {
    fx.db.insertCard(card(fx.runId, 'c1', { lane: 'draft', status: 'working' }));
    const reader = openWatchReader({ stateDbPath: fx.stateDbPath, journalDbPath: fx.journalDbPath }, fx.runId);
    try {
      let now = 1_000_100;
      const session = createLiveSession(reader, emptyContext(), () => now);
      let notified = 0;
      session.store.subscribe(() => {
        notified += 1;
      });
      expect(session.store.getView().rows.map((r) => r.state)).toEqual(['working']);
      expect(session.store.getView().elapsedSec).toBe(100);

      fx.db.appendJournalSpan({
        runId: fx.runId, cardId: 'c1', station: 'draft', attempt: 1, name: 'draft.transform',
        usage: { model: 'm', inputTokens: 700, outputTokens: 300, costUsd: 0.25 },
      });
      fx.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = 'c1'").run();
      now = 1_000_160;
      session.tick();

      const view = session.store.getView();
      expect(notified).toBe(1);
      expect(view.rows[0]).toMatchObject({ state: 'done', tokens: 1000, costUsd: 0.25 });
      expect(view.elapsedSec).toBe(160);
      expect(session.gapsSeen()).toEqual(expect.arrayContaining(['kernel-heartbeat', 'plan-quota', 'flow-at-run']));
    } finally {
      reader.close();
    }
  });
});
