/**
 * The War Room screen as a grid of styled cells (issue #89).
 *
 * `layoutScreen` turns a `WatchView` into exactly `height` lines of exactly
 * `width` cells, each a list of styled segments. It is pure, so the screen can
 * be checked without a terminal; the React layer (app.tsx) only maps segments
 * to `<span>`s. Layout follows design/war-room/README.md: box-drawing borders,
 * 8-cell header meters of full and eighth blocks, one row per card, the
 * selected row's details in a status line, key hints in the footer.
 *
 * Slice 1 draws the header and the rows. In place of the waterfall's time axis
 * each row shows its station visits in order, one cell per visit, because
 * card_log records no times (schema gap `card-log-timestamp`).
 */

import { COLORS, stationHue } from './palette';
import { formatDuration, formatTokens, type Meter, type RowView, type WatchView } from './projection';

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export type Line = Segment[];

export const MIN_WIDTH = 160;
export const MIN_HEIGHT = 20;

const NOT_RECORDED = 'not recorded';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Cell width of a string. Every glyph this module draws is one cell wide. */
export function cellWidth(text: string): number {
  return [...text].length;
}

/** Cut or pad `text` to exactly `width` cells, marking a cut with an ellipsis. */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  const chars = [...text];
  if (chars.length > width) return chars.slice(0, Math.max(0, width - 1)).join('') + '…';
  const pad = ' '.repeat(width - chars.length);
  return align === 'left' ? text + pad : pad + text;
}

export function lineWidth(line: Line): number {
  return line.reduce((n, s) => n + cellWidth(s.text), 0);
}

/** Pad or cut a line to exactly `width` cells. */
function fitLine(line: Line, width: number, bg?: string): Line {
  const out: Line = [];
  let used = 0;
  for (const seg of line) {
    if (used >= width) break;
    const w = cellWidth(seg.text);
    if (used + w <= width) {
      out.push(seg);
      used += w;
    } else {
      out.push({ ...seg, text: [...seg.text].slice(0, width - used).join('') });
      used = width;
    }
  }
  if (used < width) out.push({ text: ' '.repeat(width - used), ...(bg !== undefined ? { bg } : {}) });
  return out;
}

const border = (text: string): Segment => ({ text, fg: COLORS.border });
const dim = (text: string): Segment => ({ text, fg: COLORS.textDim });
const normal = (text: string): Segment => ({ text, fg: COLORS.textNormal });
const bold = (text: string): Segment => ({ text, fg: COLORS.textBold, bold: true });
export const notRecorded = (text = NOT_RECORDED): Segment => ({ text, fg: COLORS.notRecordedFg, bg: COLORS.notRecordedBg });

/** An 8-cell meter, loud at 80% or more (design README). */
export function meterSegments(label: string, meter: Meter): Segment[] {
  if (meter.fraction === null) {
    return [normal(`${label} `), notRecorded(meter.text)];
  }
  const f = Math.max(0, Math.min(1, meter.fraction));
  const eighths = Math.round(f * 64);
  const full = Math.floor(eighths / 8);
  const part = EIGHTHS[eighths % 8]!;
  const empty = 8 - full - (part === '' ? 0 : 1);
  const loud = meter.fraction >= 0.8;
  const fill = loud ? COLORS.meterLoud : COLORS.meterFill;
  return [
    normal(`${label} `),
    { text: '█'.repeat(full) + part, fg: fill },
    { text: '░'.repeat(Math.max(0, empty)), fg: COLORS.meterEmpty },
    loud ? { text: ` ${meter.text}`, fg: COLORS.meterLoud, bold: true } : bold(` ${meter.text}`),
  ];
}

function elapsedText(view: WatchView): Segment {
  if (view.elapsedSec === null) return notRecorded(`T+ ${NOT_RECORDED}`);
  return bold(`${view.elapsedIsLowerBound ? '≥' : ''}T+${formatDuration(view.elapsedSec)}`);
}

function headerLine(view: WatchView, inner: number): Line {
  const sep = border(' │ ');
  const t = view.tallies;
  const tallies: Segment[] = [
    { text: `${t.working} working`, fg: t.working > 0 ? COLORS.working : COLORS.textDim },
    dim(' '),
    normal(`${t.waiting} waiting`),
    dim(' '),
    { text: `${t.held} held`, fg: t.held > 0 ? COLORS.held : COLORS.textNormal, bold: t.held > 0 },
    dim(' '),
    { text: `${t.done} done`, fg: COLORS.doneText },
    dim(' '),
    { text: `${t.scrap} scrap`, fg: t.scrap > 0 ? COLORS.scrap : COLORS.textNormal },
  ];
  const left: Line = [
    { text: ' CONDUIT', fg: COLORS.wordmark, bold: true },
    sep,
    ...meterSegments('WALL', view.wall),
    sep,
    ...meterSegments('TOKENS', view.tokens),
    sep,
    ...meterSegments('QUOTA 5h', view.quota),
    sep,
    ...meterSegments('WATCHDOG', view.watchdog),
    sep,
    ...tallies,
  ];
  const right: Line = [sep, elapsedText(view), dim(' ')];
  const gap = inner - lineWidth(left) - lineWidth(right);
  return [...left, { text: ' '.repeat(Math.max(0, gap)) }, ...right];
}

function legendLine(view: WatchView): Line {
  const out: Line = [{ text: ' '.repeat(29) }];
  view.stations.forEach((s, i) => {
    out.push({ text: s, fg: stationHue(i).live, bold: true });
    out.push({ text: '  ' });
  });
  return out;
}

// Column widths for a card row, inside the side borders.
const COL = { marker: 1, name: 26, lane: 14, tokens: 9, cost: 9, attempt: 7, rework: 8, state: 15 };
const FIXED = COL.marker + COL.name + COL.lane + COL.tokens + COL.cost + COL.attempt + COL.rework + COL.state + 2;

function columnHeader(inner: number): Line {
  const trail = inner - FIXED;
  return [
    dim(fit(' card', COL.marker + COL.name)),
    dim(fit('station', COL.lane)),
    dim(' '),
    dim(fit('station visits, in order (time axis not recorded)', trail)),
    dim(' '),
    dim(fit('tokens', COL.tokens, 'right')),
    dim(fit('cost', COL.cost, 'right')),
    dim(fit('att', COL.attempt, 'right')),
    dim(fit('rework', COL.rework, 'right')),
    dim(fit('  state', COL.state)),
  ];
}

function treeName(row: RowView): string {
  if (row.depth === 0) return ` ${row.id}`;
  return ` ${'  '.repeat(row.depth - 1)}${row.lastSibling ? '└─' : '├─'} ${row.id}`;
}

function laneSegment(row: RowView): Segment {
  if (row.lane === null) return notRecorded(fit(NOT_RECORDED, COL.lane));
  if (row.stationIndex === null) return dim(fit(row.lane, COL.lane));
  const hue = stationHue(row.stationIndex);
  const color = row.state === 'done' ? hue.past : hue.live;
  return { text: fit(row.lane, COL.lane), fg: color, bold: row.state === 'working' };
}

/** One cell per station visit, oldest first; « marks a visit that was a rework bounce. */
function trailSegments(row: RowView, width: number): Segment[] {
  const cells: Segment[] = [];
  row.visits.forEach((v, i) => {
    if (v.rework) cells.push({ text: '«', fg: COLORS.rework, bold: true });
    const hue = v.stationIndex !== null ? stationHue(v.stationIndex) : null;
    const last = i === row.visits.length - 1;
    let fg = hue === null ? COLORS.textDim : last && row.state !== 'done' ? hue.live : hue.past;
    if (row.state === 'done' && hue !== null) fg = hue.done;
    cells.push({ text: '█', fg });
  });
  if (row.state === 'scrap') {
    cells.push({ text: ` SCRAP · ${row.terminalReason ?? NOT_RECORDED}`, fg: COLORS.scrap, bold: true });
  }
  // Keep the newest visits when the trail is wider than the column.
  let used = cells.reduce((n, s) => n + cellWidth(s.text), 0);
  while (used > width - 1 && cells.length > 0) {
    used -= cellWidth(cells.shift()!.text);
  }
  if (cells.length < row.visits.length + (row.state === 'scrap' ? 1 : 0) && used < width) {
    cells.unshift(dim('…'));
  }
  return cells;
}

function stateSegment(row: RowView): Segment {
  const text = fit(`  ${row.stateToken}`, COL.state);
  switch (row.state) {
    case 'working':
      return { text, fg: COLORS.working, bold: true };
    case 'held':
      return { text: fit(` ${row.stateToken}`, COL.state), fg: COLORS.heldText, bg: COLORS.held, bold: true };
    case 'scrap':
      return { text: fit(` ${row.stateToken}`, COL.state), fg: COLORS.heldText, bg: COLORS.scrap, bold: true };
    case 'done':
      return { text, fg: COLORS.doneText };
    case 'unknown':
      return { text, fg: COLORS.notRecordedFg };
    default:
      return { text, fg: COLORS.textNormal };
  }
}

function cardLine(row: RowView, inner: number, selected: boolean): Line {
  const trailWidth = inner - FIXED;
  const textColor = row.state === 'done' ? COLORS.doneText : COLORS.textBold;
  const trail = trailSegments(row, trailWidth);
  const attempt = row.attempt === null ? '' : `#${row.attempt}${row.maxAttempts !== null ? `/${row.maxAttempts}` : ''}`;
  const rework = row.reworks > 0 || row.reworkCap !== null ? `rw${row.reworks}${row.reworkCap !== null ? `/${row.reworkCap}` : ''}` : '';
  const line: Line = [
    { text: selected ? '>' : ' ', fg: COLORS.wordmark, bold: true },
    { text: fit(treeName(row), COL.name), fg: textColor, bold: selected },
    laneSegment(row),
    { text: ' ' },
    ...fitLine(trail, trailWidth),
    { text: ' ' },
    { text: fit(row.tokens > 0 ? formatTokens(row.tokens) : '·', COL.tokens, 'right'), fg: COLORS.textNormal },
    { text: fit(row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : '·', COL.cost, 'right'), fg: COLORS.textNormal },
    { text: fit(attempt, COL.attempt, 'right'), fg: COLORS.textNormal },
    { text: fit(rework, COL.rework, 'right'), fg: row.reworks > 0 ? COLORS.rework : COLORS.textDim },
    stateSegment(row),
  ];
  return selected ? line.map((s) => (s.bg === undefined ? { ...s, bg: COLORS.selectedBg } : s)) : line;
}

/** The selected row's details (design README: no hover, a status line instead). */
export function statusSegments(row: RowView | undefined): Line {
  if (row === undefined) return [normal(' no cards in this run')];
  const sep = border(' │ ');
  const out: Line = [bold(` ${row.id}`), sep];
  if (row.lane !== null) {
    out.push(normal(`${row.lane} attempt ${row.attempt ?? '?'}`));
  } else {
    out.push(normal('lane '), notRecorded());
  }
  if (row.reworks > 0 || row.reworkCap !== null) {
    out.push(normal(` · rework ${row.reworks}/${row.reworkCap ?? '?'}`));
  }
  out.push(sep, normal(`$${row.costUsd.toFixed(2)} · ${formatTokens(row.tokens)} tok`), sep);
  if (row.state === 'held') {
    out.push({ text: 'HELD', fg: COLORS.held, bold: true });
    out.push(normal(row.heldForSec !== null ? ` for ${formatDuration(row.heldForSec)} · on_timeout ` : ' · on_timeout '));
    out.push(notRecorded());
  } else if (row.state === 'scrap') {
    out.push({ text: `SCRAP · ${row.terminalReason ?? NOT_RECORDED}`, fg: COLORS.scrap, bold: true });
  } else if (row.lastTool !== null) {
    const t = row.lastTool;
    const outcome = t.running
      ? 'running'
      : t.exitCode !== null
        ? `exit ${t.exitCode}`
        : t.isError === true
          ? 'error'
          : 'ok';
    out.push(normal(`last call ${t.name ?? '?'}${t.path !== null ? ` ${t.path}` : ''} `));
    out.push({ text: outcome, fg: t.running ? COLORS.working : t.isError === true || (t.exitCode ?? 0) !== 0 ? COLORS.scrap : COLORS.textNormal });
  } else if (row.lastSpanName !== null) {
    out.push(normal(`last span ${row.lastSpanName}`));
  } else {
    out.push(normal('last call '), notRecorded());
  }
  if (row.lastVerdict !== null && row.lastVerdict.verdict === 'reject') {
    const findings = row.lastVerdict.findings;
    out.push(sep, { text: 'rejected', fg: COLORS.rework }, normal(findings !== null && findings.length > 0 ? `: ${findings[0]}` : ''));
  }
  return out;
}

function footerLine(view: WatchView, inner: number): Line {
  const badge: Segment =
    view.mode === 'live'
      ? { text: ' LIVE ', fg: '#000000', bg: COLORS.working, bold: true }
      : { text: ' REPLAY ', fg: '#000000', bg: '#00BFFF', bold: true };
  const left: Line = [{ text: ' ' }, badge, { text: '  ' }, notRecorded('kernel not observed'), { text: '  ' }];
  if (view.ticker !== null) {
    left.push(normal(`${view.ticker.cardId}  ${view.ticker.text}`));
  }
  const hints = normal('j/k select  q quit ');
  const room = inner - cellWidth(hints.text);
  return [...fitLine(left, room), hints];
}

export interface LayoutInput {
  view: WatchView;
  selected: number;
  width: number;
  height: number;
}

/** The full screen. Always exactly `height` lines of exactly `width` cells. */
export function layoutScreen({ view, selected, width, height }: LayoutInput): Line[] {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const msg = `conduit watch needs at least ${MIN_WIDTH}x${MIN_HEIGHT} cells; this terminal is ${width}x${height}.`;
    const lines: Line[] = [];
    for (let y = 0; y < height; y++) {
      lines.push(fitLine(y === Math.floor(height / 2) ? [bold(fit(msg, width))] : [], width));
    }
    return lines;
  }

  const inner = width - 2;
  const side = (content: Line, bg?: string): Line => [border('│'), ...fitLine(content, inner, bg), border('│')];
  const rule = (l: string, r: string): Line => [border(l + '─'.repeat(inner) + r)];

  const bodyHeight = height - 9;
  const rows = view.rows;
  const sel = rows.length === 0 ? -1 : Math.max(0, Math.min(selected, rows.length - 1));
  const offset = sel < bodyHeight ? 0 : sel - bodyHeight + 1;

  const lines: Line[] = [rule('┌', '┐'), side(headerLine(view, inner)), rule('├', '┤'), side(legendLine(view)), side(columnHeader(inner))];
  for (let i = 0; i < bodyHeight; i++) {
    const row = rows[offset + i];
    if (row === undefined) {
      lines.push(side(i === 0 && rows.length === 0 ? [dim(' no cards recorded for this run yet')] : []));
    } else {
      const selectedRow = offset + i === sel;
      lines.push(side(cardLine(row, inner, selectedRow), selectedRow ? COLORS.selectedBg : undefined));
    }
  }
  const status = statusSegments(sel === -1 ? undefined : rows[sel]).map((s) => (s.bg === undefined ? { ...s, bg: COLORS.statusBg } : s));
  lines.push(rule('├', '┤'), side(status, COLORS.statusBg), side(footerLine(view, inner)), rule('└', '┘'));
  return lines;
}
