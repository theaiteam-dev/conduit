/**
 * The live loop for `conduit watch` (issue #89): each tick polls the reader,
 * folds the new rows onto the running fold and derives the view again. Live
 * is replay at the journal's head: the same `foldEvents` and `deriveView`.
 */

import type { ViewStore } from './app';
import { deriveView, emptyFold, foldEvents, type Fold, type WatchContext, type WatchView } from './projection';
import type { WatchReader } from './reader';
import type { SchemaGapId } from './schema-gaps';
import type { StateSnapshot } from './events';

export interface LiveSession {
  store: ViewStore;
  /** Poll once and re-derive the view. Called on a timer by the command. */
  tick(): void;
  /** Every schema gap any view in this session rendered (the FR-13 report). */
  gapsSeen(): SchemaGapId[];
}

export function createLiveSession(reader: WatchReader, context: WatchContext, nowSec: () => number): LiveSession {
  let fold: Fold = emptyFold();
  let snapshot: StateSnapshot | null = null;
  let view: WatchView;
  const gaps = new Set<SchemaGapId>();
  const listeners = new Set<() => void>();

  const refresh = (): void => {
    fold = foldEvents(fold, reader.poll());
    // A busy state DB returns null: keep the last snapshot rather than blank the rows.
    snapshot = reader.readState() ?? snapshot;
    view = deriveView(fold, { runId: reader.runId, mode: 'live', context, snapshot, nowSec: nowSec() });
    for (const gap of view.gaps) gaps.add(gap);
  };
  refresh();

  return {
    store: {
      getView: () => view,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    tick() {
      refresh();
      for (const listener of listeners) listener();
    },
    gapsSeen: () => [...gaps],
  };
}
