/**
 * Startup and tick guards for `conduit watch` (issue #89), kept apart from the
 * renderer so they can be tested without loading it.
 *
 * A busy state DB must never be reported as a missing run or an empty
 * database: both reads that feed those messages distinguish "busy" from "read
 * and absent", retry a bounded number of times, and then say the DB is busy.
 */

import type { RunSnapshot } from './events';
import { newestRunId, openWatchReader, WatchBusyError, type WatchReader, type WatchReaderPaths } from './reader';

export interface WatchStartOptions extends WatchReaderPaths {
  /** The run to watch; null watches the newest run in the state DB. */
  runId: string | null;
}

export interface StartupDeps {
  /** Total tries for each busy-prone read. */
  attempts: number;
  /** Wait between tries. */
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  newestRunId: (stateDbPath: string) => string | null;
  openWatchReader: (paths: WatchReaderPaths, runId: string) => WatchReader;
}

export type WatchStart =
  | { ok: true; runId: string; reader: WatchReader; run: RunSnapshot }
  | { ok: false; message: string };

const defaults: StartupDeps = {
  attempts: 5,
  delayMs: 200,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newestRunId,
  openWatchReader,
};

export async function resolveWatchStart(
  opts: WatchStartOptions,
  overrides: Partial<StartupDeps> = {},
): Promise<WatchStart> {
  const deps: StartupDeps = { ...defaults, ...overrides };
  const busyMessage = `error: state database is busy, try again: ${opts.stateDbPath}`;

  /** Run `read` until it stops being busy; null when every try was busy. */
  const untilNotBusy = async <T>(read: () => T | typeof BUSY): Promise<T | typeof BUSY> => {
    for (let attempt = 1; attempt <= deps.attempts; attempt++) {
      let result: T | typeof BUSY;
      try {
        result = read();
      } catch (err) {
        if (!(err instanceof WatchBusyError)) throw err;
        result = BUSY;
      }
      if (result !== BUSY) return result;
      if (attempt < deps.attempts) await deps.sleep(deps.delayMs);
    }
    return BUSY;
  };

  let runId = opts.runId;
  if (runId === null) {
    const newest = await untilNotBusy(() => deps.newestRunId(opts.stateDbPath));
    if (newest === BUSY) return { ok: false, message: busyMessage };
    if (newest === null) return { ok: false, message: `error: no runs recorded in ${opts.stateDbPath}` };
    runId = newest;
  }

  const reader = deps.openWatchReader({ stateDbPath: opts.stateDbPath, journalDbPath: opts.journalDbPath }, runId);
  try {
    const state = await untilNotBusy(() => {
      const result = reader.readStateOrBusy();
      return result.busy ? BUSY : result.snapshot;
    });
    if (state === BUSY) {
      reader.close();
      return { ok: false, message: busyMessage };
    }
    if (state.run === null) {
      reader.close();
      return { ok: false, message: `error: run ${JSON.stringify(runId)} not found in ${opts.stateDbPath}` };
    }
    return { ok: true, runId, reader, run: state.run };
  } catch (err) {
    reader.close();
    throw err;
  }
}

const BUSY = Symbol('busy');

/**
 * Run one tick of the live loop. A throw (a journal that cannot be opened, a
 * non-busy SQLite error) goes to `onError` instead of escaping a timer
 * callback, where it would leave the renderer and the reader open.
 */
export function guardedTick(tick: () => void, onError: (err: unknown) => void): void {
  try {
    tick();
  } catch (err) {
    onError(err);
  }
}
