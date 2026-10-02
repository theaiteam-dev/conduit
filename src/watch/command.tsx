/**
 * `conduit watch` (issue #89): open the run's DBs read-only, follow the
 * journal, and render the War Room in the terminal until the user quits.
 *
 * Loaded with a dynamic import from the CLI, so the native renderer is only
 * loaded by this command.
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { WatchApp } from './app';
import { loadWatchContext } from './context';
import { createLiveSession } from './live';
import { newestRunId, openWatchReader } from './reader';
import { formatGapReport } from './schema-gaps';

/** Poll interval. The PRD's live-lag target is 2 seconds. */
export const POLL_INTERVAL_MS = 500;

export interface RunWatchOptions {
  stateDbPath: string;
  journalDbPath: string;
  /** The run to watch; null watches the newest run in the state DB. */
  runId: string | null;
  err: (line: string) => void;
}

export async function runWatch(opts: RunWatchOptions): Promise<number> {
  const runId = opts.runId ?? newestRunId(opts.stateDbPath);
  if (runId === null) {
    opts.err(`error: no runs recorded in ${opts.stateDbPath}`);
    return 1;
  }
  const reader = openWatchReader({ stateDbPath: opts.stateDbPath, journalDbPath: opts.journalDbPath }, runId);
  const run = reader.readState()?.run ?? null;
  if (run === null) {
    reader.close();
    opts.err(`error: run ${JSON.stringify(runId)} not found in ${opts.stateDbPath}`);
    return 1;
  }

  const session = createLiveSession(reader, loadWatchContext(run.flow), () => Math.floor(Date.now() / 1000));
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  return new Promise<number>((resolve) => {
    const timer = setInterval(() => session.tick(), POLL_INTERVAL_MS);
    let done = false;
    const quit = (): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      root.unmount();
      renderer.destroy();
      reader.close();
      for (const line of formatGapReport(runId, session.gapsSeen())) opts.err(line);
      resolve(0);
    };
    root.render(<WatchApp store={session.store} onQuit={quit} />);
  });
}
