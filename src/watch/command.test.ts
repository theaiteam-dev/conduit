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
import { newestRunId, openWatchReader, WatchBusyError, type WatchReader } from './reader';
import { guardedTick, resolveWatchStart } from './startup';
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

  test('a watch module that fails to load is reported, not thrown', async () => {
    const { deps, errors } = readOnlyDeps();
    deps.loadWatch = async () => {
      throw new Error("Cannot find module '@opentui/react'");
    };
    expect(await main(['watch'], deps)).toBe(1);
    expect(errors).toEqual(["error: Cannot find module '@opentui/react'"]);
  });
});

const busy = (): never => {
  throw new WatchBusyError('state.sqlite');
};

describe('watch startup', () => {
  const noSleep = { sleep: async () => {}, attempts: 3 };
  const base = (): { stateDbPath: string; journalDbPath: string; runId: string | null } => ({
    stateDbPath: fx.stateDbPath,
    journalDbPath: fx.journalDbPath,
    runId: null,
  });

  test('resolves the newest run and its snapshot', async () => {
    const start = await resolveWatchStart(base(), noSleep);
    expect(start.ok).toBe(true);
    if (start.ok) {
      expect(start.runId).toBe(fx.runId);
      expect(start.run.runId).toBe(fx.runId);
      start.reader.close();
    }
  });

  test('a run the state DB does not record is not found', async () => {
    const start = await resolveWatchStart({ ...base(), runId: 'nope' }, noSleep);
    expect(start).toEqual({ ok: false, message: expect.stringContaining('run "nope" not found') });
  });

  test('a state DB with no runs says so', async () => {
    const start = await resolveWatchStart(base(), { ...noSleep, newestRunId: () => null });
    expect(start).toEqual({ ok: false, message: expect.stringContaining('no runs recorded') });
  });

  test('a busy state DB is retried, then the run is found', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const start = await resolveWatchStart(base(), {
      attempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      newestRunId: (path) => {
        calls += 1;
        return calls < 3 ? busy() : newestRunId(path);
      },
    });
    expect(start.ok).toBe(true);
    expect(sleeps).toHaveLength(2);
    if (start.ok) start.reader.close();
  });

  test('a state DB busy on every attempt is reported as busy, not as no runs', async () => {
    let calls = 0;
    const start = await resolveWatchStart(base(), {
      ...noSleep,
      newestRunId: () => {
        calls += 1;
        return busy();
      },
    });
    expect(calls).toBe(3);
    expect(start).toEqual({ ok: false, message: expect.stringContaining('busy') });
    if (!start.ok) expect(start.message).not.toContain('no runs');
  });

  test('a busy snapshot read is retried and, if it stays busy, reported as busy not as not found', async () => {
    let reads = 0;
    let closed = 0;
    const reader = {
      runId: fx.runId,
      readStateOrBusy: () => {
        reads += 1;
        return { busy: true as const };
      },
      close: () => {
        closed += 1;
      },
    } as unknown as WatchReader;
    const start = await resolveWatchStart({ ...base(), runId: fx.runId }, { ...noSleep, openWatchReader: () => reader });
    expect(reads).toBe(3);
    expect(closed).toBe(1);
    expect(start).toEqual({ ok: false, message: expect.stringContaining('busy') });
    if (!start.ok) expect(start.message).not.toContain('not found');
  });
});

describe('guarded tick', () => {
  test('passes a tick error to the handler instead of throwing', () => {
    const seen: unknown[] = [];
    const boom = new Error('journal unopenable');
    expect(() =>
      guardedTick(
        () => {
          throw boom;
        },
        (e) => seen.push(e),
      ),
    ).not.toThrow();
    expect(seen).toEqual([boom]);
  });

  test('a tick that succeeds does not call the handler', () => {
    let ticks = 0;
    guardedTick(() => {
      ticks += 1;
    }, () => {
      throw new Error('unexpected');
    });
    expect(ticks).toBe(1);
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
