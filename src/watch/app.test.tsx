/**
 * Component tests for `conduit watch` (issue #89), through @opentui/react's
 * test renderer: text frames, span colors, keys and resize.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { WatchApp, staticStore } from './app';
import { COLORS, stationHue } from './palette';
import { deriveView, emptyFold, foldEvents, type WatchView } from './projection';
import {
  SCENARIO_NOW,
  SCENARIO_RUN,
  STALE_NOW,
  idleSnapshot,
  scenarioContext,
  scenarioEvents,
  scenarioSnapshot,
} from './scenario';
import type { StateSnapshot } from './events';

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;

afterEach(async () => {
  const s = setup;
  setup = null;
  if (s !== null) {
    await act(async () => {
      s.renderer.destroy();
    });
  }
});

function scenarioView(snapshot: StateSnapshot = scenarioSnapshot, nowSec = SCENARIO_NOW): WatchView {
  return deriveView(foldEvents(emptyFold(), scenarioEvents), {
    runId: SCENARIO_RUN,
    mode: 'live',
    context: scenarioContext,
    snapshot,
    nowSec,
  });
}

async function render(view: WatchView, width = 160, height = 30, onQuit?: () => void): Promise<Setup> {
  setup = await testRender(<WatchApp store={staticStore(view)} onQuit={onQuit} />, { width, height });
  await draw(setup);
  return setup;
}

/** Render a frame inside act(), so React flushes state before the capture. */
async function draw(s: Setup): Promise<void> {
  await act(async () => {
    await s.renderOnce();
  });
}

async function press(s: Setup, key: string): Promise<void> {
  await act(async () => {
    s.mockInput.pressKey(key);
  });
  await draw(s);
}

const hex = (rgba: { buffer: ArrayLike<number> } | { r: number; g: number; b: number }): string => {
  const [r, g, b] =
    'buffer' in rgba ? [rgba.buffer[0]!, rgba.buffer[1]!, rgba.buffer[2]!] : [rgba.r * 255, rgba.g * 255, rgba.b * 255];
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};

/** Every span on screen whose text contains `needle`, with its colors. */
function spansWith(s: Setup, needle: string): { text: string; fg: string; bg: string }[] {
  return s
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .filter((sp) => sp.text.includes(needle))
    .map((sp) => ({ text: sp.text, fg: hex(sp.fg), bg: hex(sp.bg) }));
}

describe('conduit watch screen', () => {
  test('header carries the meters, tallies and elapsed time', async () => {
    const s = await render(scenarioView());
    const header = s.captureCharFrame().split('\n')[1]!;
    expect(header).toContain('CONDUIT');
    expect(header).toContain('WALL ██▋░░░░░ 33%');
    expect(header).toContain('QUOTA 5h ██████▉░ 86%');
    expect(header).toContain('WATCHDOG worker active');
    expect(header).toContain('1 working 0 waiting 1 held 1 done 1 scrap');
    expect(header).toContain('T+47:00');
  });

  test('one row per card, in tree order, with a state token each', async () => {
    const frame = (await render(scenarioView())).captureCharFrame();
    // Rows 5..9: below the border, header, rule, legend and column header.
    const rows = frame.split('\n').slice(5, 10);
    expect(rows.map((r) => r.match(/(PRD-014|WI-2\d\d)/)![1])).toEqual(['PRD-014', 'WI-201', 'WI-204', 'WI-207', 'WI-209']);
    expect(rows[0]).toContain('awaiting');
    expect(rows[1]).toContain('✓');
    expect(rows[2]).toContain('15:00');
    expect(rows[2]).toContain('rw2/3');
    expect(rows[3]).toContain('SCRAP · no_progress');
    expect(rows[4]).toContain('HELD 30:20');
    expect(rows[4]).toContain('└─ WI-209');
  });

  test('station names and the current visit take their station color', async () => {
    const s = await render(scenarioView());
    const legend = spansWith(s, 'implement')[0]!;
    expect(legend.fg).toBe(stationHue(1).live);
    const review = spansWith(s, 'review')[0]!;
    expect(review.fg).toBe(stationHue(2).live);
  });

  test('green appears only on working elements', async () => {
    const s = await render(scenarioView());
    const green = s
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .filter((sp) => hex(sp.fg) === COLORS.working || hex(sp.bg) === COLORS.working)
      .map((sp) => sp.text.trim());
    expect(green.sort()).toEqual(['1 working', '15:00', 'LIVE'].sort());
  });

  test('the held row and the loud meter use the held amber', async () => {
    const s = await render(scenarioView());
    expect(spansWith(s, 'HELD 30:20')[0]!.bg).toBe(COLORS.held);
    expect(spansWith(s, '86%')[0]!.fg).toBe(COLORS.meterLoud);
  });

  test('watchdog: a long-running working card with an old span stays calm', async () => {
    const s = await render(scenarioView(scenarioSnapshot, STALE_NOW));
    expect(s.captureCharFrame().split('\n')[1]).toContain('WATCHDOG worker active');
    const text = spansWith(s, 'worker active')[0]!;
    expect(text.fg).toBe(COLORS.textDim);
    expect(spansWith(s, '15:00').some((sp) => sp.fg === COLORS.meterLoud)).toBe(false);
  });

  test('watchdog: an idle run with an old span fills with the loud color', async () => {
    const s = await render(scenarioView(idleSnapshot(), STALE_NOW));
    expect(s.captureCharFrame().split('\n')[1]).toContain('WATCHDOG ████████ 15:00');
    const bar = spansWith(s, '████████').find((sp) => sp.text === '████████')!;
    expect(bar.fg).toBe(COLORS.meterLoud);
    expect(spansWith(s, ' 15:00').some((sp) => sp.fg === COLORS.meterLoud)).toBe(true);
  });

  test('watchdog: a release_at-gated card stays calm', async () => {
    const s = await render(scenarioView(idleSnapshot(STALE_NOW + 300), STALE_NOW));
    expect(s.captureCharFrame().split('\n')[1]).toContain('WATCHDOG waiting');
    expect(spansWith(s, 'waiting').find((sp) => sp.text === 'waiting')!.fg).toBe(COLORS.textDim);
  });

  test('j and k move the selection and the status line follows it', async () => {
    const s = await render(scenarioView());
    const status = () => s.captureCharFrame().split('\n')[27]!;
    expect(status()).toContain('PRD-014');
    await press(s, 'j');
    await press(s, 'j');
    expect(status()).toContain('WI-204');
    expect(status()).toContain('last call Bash running');
    expect(status()).toContain('rejected: range end is exclusive');
    await press(s, 'j');
    await press(s, 'j');
    await press(s, 'j');
    expect(status()).toContain('WI-209');
    expect(status()).toContain('on_timeout not recorded');
    await press(s, 'k');
    expect(status()).toContain('SCRAP · no_progress');
    const marked = s.captureCharFrame().split('\n').filter((l) => l.startsWith('│>'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('WI-207');
  });

  test('q calls onQuit', async () => {
    let quit = 0;
    const s = await render(scenarioView(), 160, 30, () => {
      quit += 1;
    });
    await press(s, 'q');
    expect(quit).toBe(1);
  });

  test('a datum the journal lacks renders "not recorded" in its own colors', async () => {
    const view = deriveView(foldEvents(emptyFold(), scenarioEvents.filter((e) => e.source !== 'harness')), {
      runId: SCENARIO_RUN,
      mode: 'live',
      context: scenarioContext,
      snapshot: scenarioSnapshot,
      nowSec: SCENARIO_NOW,
    });
    const s = await render(view);
    expect(s.captureCharFrame().split('\n')[1]).toContain('QUOTA 5h not recorded');
    const marker = spansWith(s, 'not recorded').find((sp) => sp.text === 'not recorded')!;
    expect(marker.fg).toBe(COLORS.notRecordedFg);
    expect(marker.bg).toBe(COLORS.notRecordedBg);
    expect(view.gaps).toContain('plan-quota');
    expect(s.captureCharFrame()).toContain('kernel not observed');
  });

  test('below 160 columns it says so instead of drawing a broken frame', async () => {
    const s = await render(scenarioView());
    await act(async () => {
      s.resize(120, 30);
    });
    await draw(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('needs at least 160x20 cells; this terminal is 120x30');
    expect(frame).not.toContain('CONDUIT');
    await act(async () => {
      s.resize(160, 30);
    });
    await draw(s);
    expect(s.captureCharFrame()).toContain('CONDUIT');
  });

  test('every line is exactly the terminal width', async () => {
    for (const width of [160, 200]) {
      const s = await render(scenarioView(), width, 30);
      const lines = s.captureCharFrame().split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(30);
      for (const line of lines) expect([...line]).toHaveLength(width);
      setup = null;
      await act(async () => {
        s.renderer.destroy();
      });
    }
  });
});
