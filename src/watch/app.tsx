/**
 * `conduit watch` screen, rendered with @opentui/react (issue #89).
 *
 * The component holds only the selection; everything on screen comes from the
 * `WatchView` the store hands it, laid out by `layoutScreen`. Keys: j/k (and
 * the arrow keys) move the selection, q or ctrl-c quits.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import { COLORS } from './palette';
import { layoutScreen, type Line } from './layout';
import type { WatchView } from './projection';

/** Where the screen gets its view from: the live loop, or a fixed view in tests. */
export interface ViewStore {
  getView(): WatchView;
  subscribe(listener: () => void): () => void;
}

export function staticStore(view: WatchView): ViewStore {
  return { getView: () => view, subscribe: () => () => {} };
}

function ScreenLine({ line }: { line: Line }) {
  return (
    <text>
      {line.map((seg, i) => (
        <span
          key={i}
          fg={seg.fg ?? COLORS.textNormal}
          bg={seg.bg ?? COLORS.background}
          attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {seg.text}
        </span>
      ))}
    </text>
  );
}

export interface WatchAppProps {
  store: ViewStore;
  onQuit?: () => void;
}

export function WatchApp({ store, onQuit }: WatchAppProps) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const { width, height } = useTerminalDimensions();
  // The selection follows the card, not the row index, so a new card
  // inserted above it does not move the selection to another card.
  const [selectedId, setSelectedId] = useState<string | null>(view.rows[0]?.id ?? null);

  const index = Math.max(0, view.rows.findIndex((r) => r.id === selectedId));
  useEffect(() => {
    if (selectedId === null && view.rows.length > 0) setSelectedId(view.rows[0]!.id);
  }, [selectedId, view.rows]);

  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      onQuit?.();
      return;
    }
    if (view.rows.length === 0) return;
    if (key.name === 'j' || key.name === 'down') {
      setSelectedId(view.rows[Math.min(index + 1, view.rows.length - 1)]!.id);
    } else if (key.name === 'k' || key.name === 'up') {
      setSelectedId(view.rows[Math.max(index - 1, 0)]!.id);
    }
  });

  const lines = layoutScreen({ view, selected: index, width, height });
  return (
    <box flexDirection="column" backgroundColor={COLORS.background} width={width} height={height}>
      {lines.map((line, y) => (
        <ScreenLine key={y} line={line} />
      ))}
    </box>
  );
}
