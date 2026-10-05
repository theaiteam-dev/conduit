/** Direct tests for the station-visit trail of a card row (issue #89). */

import { describe, expect, test } from 'bun:test';
import { trailSegments } from './layout';
import type { RowView } from './projection';

function row(visits: { rework: boolean }[], state: RowView['state'] = 'working'): RowView {
  return {
    state,
    terminalReason: null,
    visits: visits.map((v, i) => ({ stationIndex: i % 3, station: `s${i % 3}`, rework: v.rework })),
  } as unknown as RowView;
}

const text = (r: RowView, width: number): string =>
  trailSegments(r, width)
    .map((s) => s.text)
    .join('');

const REWORK3 = [{ rework: true }, { rework: true }, { rework: true }];

describe('trailSegments trimming', () => {
  test('a rework marker is never shown without its block', () => {
    const r = row([{ rework: false }, { rework: true }, { rework: false }]);
    for (let w = 2; w <= 8; w++) {
      expect(text(r, w)).not.toMatch(/«(?!█)/);
    }
  });

  test('a surviving rework visit keeps its marker rather than showing as a plain visit', () => {
    // Width 4 leaves 3 columns after the ellipsis slot. Cell-wise trimming gave '…█«█',
    // where the oldest kept visit lost its marker.
    expect(text(row(REWORK3), 4)).toBe('…«█');
  });

  test('visits are trimmed whole', () => {
    // «█«█«█ is 6 columns. Width 5 leaves 4 columns: two whole visits plus the ellipsis.
    expect(text(row(REWORK3), 5)).toBe('…«█«█');
  });

  test('the ellipsis appears when a visit was dropped even though markers inflate the cell count', () => {
    // 6 cells, one visit dropped leaves 4 cells, which is not fewer than the 3 visits.
    expect(text(row(REWORK3), 6)).toBe('…«█«█');
  });

  test('no ellipsis when everything fits', () => {
    expect(text(row([{ rework: true }, { rework: false }]), 10)).toBe('«██');
  });
});
