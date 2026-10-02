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
import { guardedTick, resolveWatchStart } from './startup';
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
  const start = await resolveWatchStart(opts);
  if (!start.ok) {
    opts.err(start.message);
    return 1;
  }
  const { runId, reader, run } = start;

  const session = createLiveSession(reader, loadWatchContext(run.flow), () => Math.floor(Date.now() / 1000));
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  return new Promise<number>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Runs once, whether the user quit or a tick failed.
    const finish = (code: number, failure?: unknown): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      root.unmount();
      renderer.destroy();
      reader.close();
      if (failure !== undefined) {
        opts.err(`error: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      for (const line of formatGapReport(runId, session.gapsSeen())) opts.err(line);
      resolve(code);
    };
    timer = setInterval(() => guardedTick(() => session.tick(), (err) => finish(1, err)), POLL_INTERVAL_MS);
    root.render(<WatchApp store={session.store} onQuit={() => finish(0)} />);
  });
}
