/**
 * Pure flow renderer (WI-443; back-edges + adaptive legend WI-444;
 * flow-ordered rail layout WI-446).
 *
 * Converts a validated, frozen FlowConfig into a topology explanation string.
 * Reads strictly from the FlowConfig — never from raw YAML (PRD §6 FR-9).
 *
 * Public API: renderFlow(flow, opts?). Two styles share one flow-ordered model:
 *   - default (no opts) — the pure-ASCII fallback below (AC9), for pipes/scripts
 *   - { rich, color }   — a compact boxed topology overview plus station and
 *                         backflow tables, selected by the CLI on a TTY
 *
 * Plain layout (top-to-bottom):
 *   1. Header line — flow name
 *   2. Main rail — stations in FLOW order (traversed from the entry station via
 *      happyPathNext), each connected to its successor by a `|`/`v` rail. Fan-out
 *      parents annotate the rail with their child-path hand-off; fan-in stations
 *      carry an inline `(fan-in: ...)` note. Back-edges render as `<~` lines.
 *   3. One indented "child sub-path" block per fan-out station.
 *   4. Terminal-lane summary line.
 *   5. Adaptive legend — defines only the markers the diagram actually uses.
 *
 * Routing is derived SOLELY from flow.happyPathNext (FR-2) — never from station
 * insertion order — so an empty routing map degrades to a flat, edge-less list.
 */

import pc from 'picocolors';
import { table } from 'table';
import type { FanInPolicyConfig, FlowConfig, StationConfig } from '../types/kernel';
import type { HarnessRegistry } from '../worker/harness-adapter';

const DEFAULT_TERMINALS = ['done', 'scrap', 'hold'];
type Colors = ReturnType<typeof pc.createColors>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Right-pad `s` with spaces to width `w` (never truncates). */
function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** A station with neither a model nor a command renders no worker-kind glyph (AC5). */
function isNoWorker(station: StationConfig): boolean {
  return station.model === undefined && station.command === undefined && station.harness === undefined;
}

/** True iff `lane` names a terminal lane (done/scrap/hold or the declared set). */
function isTerminalLane(flow: FlowConfig, lane: string | null | undefined): boolean {
  if (lane === null || lane === undefined) return false;
  return (flow.terminal_lanes ?? DEFAULT_TERMINALS).includes(lane);
}

/**
 * The happy-path successor lane for `id`, read strictly from happyPathNext
 * (FR-2). Returns null when the station has no declared successor — so emptying
 * happyPathNext removes every forward edge rather than falling back to insertion
 * order or the raw `next` field.
 */
function successorOf(flow: FlowConfig, id: string): string | null {
  return flow.happyPathNext?.[id] ?? null;
}

/** Human-readable fan-in policy summary for the inline node note. */
function describeFanIn(policy: number | FanInPolicyConfig): string {
  if (typeof policy === 'number') return `survivors>=${policy}`;
  switch (policy.policy) {
    case 'quorum':
      return `quorum k>=${policy.k}`;
    case 'all':
      return 'all';
    case 'best_effort':
      return 'best-effort';
  }
}

// ---------------------------------------------------------------------------
// Traversal — flow order + child-path partitioning
// ---------------------------------------------------------------------------

/** A fan-out station and the ordered child sub-path it hands work to. */
interface ChildPath {
  parent: string;
  entry: string;
  count: number;
  ids: string[];
  childTerminal?: string;
  joinAt?: string;
}

/**
 * Walk a child sub-path from `entry`, following happy-path routing until it
 * reaches the declared child terminal, any terminal lane, or a cycle.
 */
function collectChildPath(
  flow: FlowConfig,
  entry: string,
  childTerminal: string | undefined,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = entry;
  while (cur && flow.stations[cur] && !isTerminalLane(flow, cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    const next = successorOf(flow, cur);
    if (next === childTerminal || isTerminalLane(flow, next)) break;
    cur = next;
  }
  return chain;
}

/**
 * Order the main-rail stations in flow order: a depth-first walk from each entry
 * station (one with no incoming main-rail edge), following happy-path routing.
 * Any station not reachable that way (islands, pure cycles) is appended in
 * declaration order so nothing is silently dropped.
 */
function orderMainPath(flow: FlowConfig, childIds: Set<string>): string[] {
  const main = Object.keys(flow.stations).filter((id) => !childIds.has(id));
  const mainSet = new Set(main);

  const targeted = new Set<string>();
  for (const id of main) {
    const next = successorOf(flow, id);
    if (next && mainSet.has(next)) targeted.add(next);
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !mainSet.has(id)) return;
    visited.add(id);
    ordered.push(id);
    const next = successorOf(flow, id);
    if (next && mainSet.has(next)) visit(next);
  };

  for (const id of main) if (!targeted.has(id)) visit(id); // entry stations first
  for (const id of main) visit(id); // defensive: any unreachable leftovers
  return ordered;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the first line: the flow name header. */
function renderHeader(flow: FlowConfig): string {
  return `Flow: ${flow.name ?? '(unnamed)'}`;
}

/** Column widths for a block, so node lines align into id / kind columns. */
function colWidths(flow: FlowConfig, ids: string[]): { idW: number; kindW: number } {
  let idW = 0;
  let kindW = 0;
  for (const id of ids) {
    idW = Math.max(idW, id.length);
    const station = flow.stations[id];
    if (station && !isNoWorker(station)) kindW = Math.max(kindW, `[${station.kind}]`.length);
  }
  return { idW, kindW };
}

/**
 * Render a single station node line.
 *
 * Worker stations show aligned id / kind columns, then role, worker token
 * (cmd= for deterministic, model= for transform/agentic), and any status
 * markers. No-worker stations (checks, ranks) show id + markers only (AC5).
 */
function renderNode(
  flow: FlowConfig,
  id: string,
  indent: number,
  idW: number,
  kindW: number,
  harnessRegistry?: HarnessRegistry,
): string {
  const station = flow.stations[id]!;
  const pre = ' '.repeat(indent);

  // Status markers, independent of worker presence.
  const markers: string[] = [];
  if (station.effectful) markers.push('(!)');
  if (station.gateCheck) markers.push('(check)');
  else if (station.rankCheck) markers.push('(rank)');
  if (station.overlap === true) markers.push('(overlap)');
  if (station.fan_in !== undefined) markers.push(`(fan-in: ${describeFanIn(station.fan_in)})`);

  if (isNoWorker(station)) {
    return pre + [pad(id, idW), ...markers].join('  ');
  }

  const cells = [pad(id, idW), pad(`[${station.kind}]`, kindW)];
  if (station.role !== undefined) cells.push(station.role);
  // Deterministic stations show their command; transform/agentic show their model (AC3/AC4).
  if (station.kind === 'deterministic' && station.command !== undefined) {
    cells.push(`cmd=${station.command}`);
  } else if (station.model !== undefined) {
    cells.push(`model=${station.model}`);
  }
  cells.push(...markers);
  cells.push(...harnessDetails(station, harnessRegistry));
  return pre + cells.join('  ');
}

/**
 * Render the rail (and any back-edges) leading out of a station.
 *
 * Back-edges (WI-444) render as `<~` lines labeled from the source station's
 * gateCheck (criticRole preferred, then criticModel) — never from rankCheck
 * (AC3); a gate critic with neither renders no label rather than an empty `[]`.
 * A fan-out parent annotates the rail with its child-path hand-off. The forward
 * `|`/`v` rail is drawn from happy-path routing; when the successor lands
 * outside this block (a terminal lane), its name is emitted as the rail's foot.
 */
function renderRail(flow: FlowConfig, id: string, indent: number, blockIds: string[]): string[] {
  // The rail nestles two columns in from the node it descends from.
  const pre = ' '.repeat(indent + 2);
  const lines: string[] = [];
  const station = flow.stations[id]!;

  // Back-edges out of this station (gate rejection paths).
  for (const edge of flow.back_edges ?? []) {
    if (edge.from !== id) continue;
    const gateCheck = flow.stations[id]?.gateCheck;
    const labelText = gateCheck?.criticRole || gateCheck?.criticModel;
    const label = labelText ? ` [${labelText}]` : '';
    lines.push(`${pre}<~ ${edge.to}${label}`);
  }

  const next = successorOf(flow, id);
  const isFanOut = station.fan_out !== undefined && station.child_entry !== undefined;
  if (next === null && !isFanOut) return lines;

  lines.push(`${pre}|`);
  if (isFanOut) {
    lines.push(`${pre}| fan-out x${station.fan_out} -> child path '${station.child_entry}'`);
  }
  if (next !== null) {
    lines.push(`${pre}v`);
    // The next station is rendered by the caller's loop only when it's in this
    // block; otherwise (a terminal lane) draw it as the rail's foot.
    if (!blockIds.includes(next)) lines.push(`${pre}${next}`);
  }
  return lines;
}

/** Render one flow-ordered block (main rail or a child sub-path) as lines. */
function renderBlock(
  flow: FlowConfig,
  ids: string[],
  indent: number,
  harnessRegistry?: HarnessRegistry,
): string[] {
  const { idW, kindW } = colWidths(flow, ids);
  const lines: string[] = [];
  for (const id of ids) {
    lines.push(renderNode(flow, id, indent, idW, kindW, harnessRegistry));
    lines.push(...renderRail(flow, id, indent, ids));
  }
  return lines;
}

/** Render the terminal-lane summary line. */
function renderTerminals(flow: FlowConfig): string {
  const terminals = flow.terminal_lanes ?? DEFAULT_TERMINALS;
  return `terminals: ${terminals.join('  ')}`;
}

/**
 * Render the adaptive legend (WI-444).
 *
 * Emits a definition only for markers the diagram actually uses:
 *   - Worker-kind glyphs that appear on at least one node line
 *   - The effectful marker when at least one station is effectful
 *   - The (check)/(rank) node markers when at least one station carries them
 *   - The back-edge marker only when flow.back_edges is non-empty
 *
 * Legend entries use the exact domain terms from the PRD: 'deterministic',
 * 'transform', 'agentic', 'effectful', 'check', 'rank', 'back-edge'.
 */
function renderLegend(flow: FlowConfig): string {
  const entries: string[] = [];

  // Collect worker kinds that appear on actual node lines (no-worker stations
  // do not emit a kind glyph, so they are excluded from this set).
  const usedKinds = new Set<string>();
  for (const station of Object.values(flow.stations)) {
    if (station.model !== undefined || station.command !== undefined) {
      usedKinds.add(station.kind);
    }
  }

  // Emit kind entries in canonical order.
  if (usedKinds.has('deterministic')) {
    entries.push('  [deterministic] = command-based worker (no LLM)');
  }
  if (usedKinds.has('transform')) {
    entries.push('  [transform] = single LLM call, typed in/out (no tools, no loop)');
  }
  if (usedKinds.has('agentic')) {
    entries.push('  [agentic] = multi-turn LLM agent with tools');
  }

  // Effectful marker — only when at least one station is effectful.
  const stations = Object.values(flow.stations);
  if (stations.some((s) => s.effectful)) {
    entries.push('  (!) = effectful station (billed call or irreversible side-effect)');
  }

  // Check/rank node markers — only when at least one station carries them.
  if (stations.some((s) => s.gateCheck)) {
    entries.push('  (check) = station with a quality gate (back-edge on reject)');
  }
  if (stations.some((s) => s.rankCheck)) {
    entries.push('  (rank) = station that ranks fan-out candidates');
  }
  if (stations.some((s) => s.overlap === true)) {
    entries.push('  (overlap) = harness station whose cards may run as overlapping calls under --concurrency');
  }

  // Back-edge marker — only when the flow has at least one back-edge.
  if (flow.back_edges && flow.back_edges.length > 0) {
    entries.push('  <~ = back-edge (gate rejection path)');
  }

  if (entries.length === 0) return '';

  return 'Legend:\n' + entries.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Rendering style options. Defaults render the pure-ASCII fallback (AC9). */
export interface RenderOptions {
  /** Rich TUI: compact boxed topology overview plus tables (TTY only). */
  rich?: boolean;
  /** Wrap tokens in ANSI color codes. Only honored alongside `rich`. */
  color?: boolean;
  /**
   * Engine-config harness adapter registry (WI-573). Only needed to resolve a
   * `kind: harness` station's usage-blind capability — a frozen FlowConfig
   * alone cannot carry adapter capability. Absent → no usage-blind indicator
   * is rendered (identity/tools/waiver still render from StationConfig alone).
   */
  harnessRegistry?: HarnessRegistry;
}

/**
 * Convert a validated FlowConfig into a topology explanation string.
 *
 * Default (no opts) is the pure-ASCII fallback — no non-ASCII glyphs, no ANSI
 * color (AC9) — so piped/redirected output stays clean and script-friendly.
 * `{ rich: true }` draws the compact boxed topology overview plus station and
 * backflow tables; `{ rich: true, color: true }` adds ANSI color. The CLI
 * selects rich+color on a TTY (see cmdExplain's --color handling).
 */
export function renderFlow(flow: FlowConfig, opts: RenderOptions = {}): string {
  return opts.rich
    ? renderRich(flow, opts.color ?? false, opts.harnessRegistry)
    : renderPlain(flow, opts.harnessRegistry);
}

/**
 * Partition the graph into a flow-ordered main rail plus one block per fan-out
 * child sub-path, so the main spine stays a single readable line. Shared by both
 * the plain and rich renderers.
 */
function partition(flow: FlowConfig): { mainIds: string[]; childPaths: ChildPath[] } {
  const childIds = new Set<string>();
  const childPaths: ChildPath[] = [];
  for (const [id, station] of Object.entries(flow.stations)) {
    if (station.fan_out !== undefined && station.child_entry !== undefined) {
      const ids = collectChildPath(flow, station.child_entry, station.child_terminal);
      ids.forEach((c) => childIds.add(c));
      childPaths.push({
        parent: id,
        entry: station.child_entry,
        count: station.fan_out,
        ids,
        ...(station.child_terminal !== undefined ? { childTerminal: station.child_terminal } : {}),
        ...(station.resume_at !== undefined ? { joinAt: station.resume_at } : {}),
      });
    }
  }
  return { mainIds: orderMainPath(flow, childIds), childPaths };
}

/** The pure-ASCII fallback layout (AC9). */
function renderPlain(flow: FlowConfig, harnessRegistry?: HarnessRegistry): string {
  const out: string[] = [renderHeader(flow), ''];
  const { mainIds, childPaths } = partition(flow);

  // Main rail in flow order.
  out.push(...renderBlock(flow, mainIds, 0, harnessRegistry));

  // One indented block per child sub-path.
  for (const cp of childPaths) {
    out.push('', `child sub-path (runs x${cp.count}):`);
    out.push(...renderBlock(flow, cp.ids, 2, harnessRegistry));
  }

  out.push('', renderTerminals(flow));
  const legend = renderLegend(flow);
  if (legend) out.push(legend);

  // Trim trailing whitespace (alignment padding never falls at line end except
  // on a bare id), keeping output clean and ASCII-only.
  return out.map((line) => line.replace(/[ ]+$/, '')).join('\n');
}

// ---------------------------------------------------------------------------
// Rich TUI layout (WI-446) — compact flow boxes + tables, optional color.
// ---------------------------------------------------------------------------

/** Box-drawing + node glyphs used by the rich layout. */
const GLYPH = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
  ldiv: '├',
  rdiv: '┤',
  station: '●',
  check: '◇',
  terminal: '◎',
  down: '▼',
  branch: '└',
  rework: '↺',
  arrow: '→',
  dot: '·',
  times: '×',
  geq: '≥',
} as const;

/** ANSI SGR codes. Applied only when color is enabled. */
const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** A rendered fragment carrying both its visible text and its styled form. */
interface Frag {
  /** Visible characters (no ANSI) — used for width math. */
  p: string;
  /** Styled characters (with ANSI when color is on). */
  s: string;
}

/** One physical line: visible text + styled text. */
interface Row {
  plain: string;
  styled: string;
}

/** Color for a worker kind's glyph and label. */
function kindSgr(kind: string): string {
  return kind === 'transform' ? SGR.cyan : kind === 'deterministic' ? SGR.yellow : SGR.magenta;
}

/** Color for a terminal lane by name (done=green, scrap=red, hold=yellow). */
function terminalSgr(name: string): string {
  return name === 'done'
    ? SGR.green
    : name === 'scrap'
      ? SGR.red
      : name === 'hold'
        ? SGR.yellow
        : SGR.dim;
}

/** Fan-in summary using the Unicode `≥` glyph. */
function describeFanInRich(policy: number | FanInPolicyConfig): string {
  if (typeof policy === 'number') return `survivors${GLYPH.geq}${policy}`;
  switch (policy.policy) {
    case 'quorum':
      return `quorum k${GLYPH.geq}${policy.k}`;
    case 'all':
      return 'all';
    case 'best_effort':
      return 'best-effort';
  }
}

/** Humanize machine lane ids for diagram labels while leaving tables exact. */
function humanizeLane(lane: string): string {
  return lane.replace(/[_-]+/g, ' ');
}

/** Strip ANSI escape sequences for visible-width calculations. */
function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function visibleLength(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

function padVisible(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function stationKindLabel(station: StationConfig): string {
  if (station.rankCheck) return 'rank';
  if (station.gateCheck) return `${station.kind}+gate`;
  return station.kind;
}

/**
 * Harness-specific explain surface (WI-573, NFR-Op-4): the flow author's
 * mental model must match the runtime. Returns [] for non-harness stations.
 *   - adapter identity (station.harness) and the declared tools allowlist —
 *     available from the frozen StationConfig alone (WI-559), no registry.
 *   - a VISIBLE unrestricted_tools waiver WARNING (NFR-Security-3) — the
 *     operator must SEE a security opt-out, never a silent one.
 *   - a usage-blind indicator (NFR-Op-2) — only resolvable via the engine-config
 *     harness registry (a frozen FlowConfig cannot carry adapter capability),
 *     so this entry appears only when `harnessRegistry` is supplied.
 */
function harnessDetails(station: StationConfig, harnessRegistry?: HarnessRegistry): string[] {
  if (station.kind !== 'harness') return [];
  const details: string[] = [];
  if (station.harness !== undefined) details.push(`harness=${station.harness}`);
  if (station.tools !== undefined && station.tools.length > 0) {
    details.push(`tools=${station.tools.join(',')}`);
  }
  if (station.unrestricted_tools === true) {
    details.push('WARNING: unrestricted_tools waiver active (tools allowlist not enforced)');
  }
  if (harnessRegistry !== undefined && station.harness !== undefined) {
    const resolved = harnessRegistry.resolve(station.harness);
    if (resolved.ok && resolved.adapter.reportsUsage === false) {
      details.push('usage-blind (adapter cannot report token/cost usage)');
    }
  }
  return details;
}

function workerLabel(station: StationConfig): string {
  if (station.rankCheck) return station.rankCheck.criticModel;

  const worker = station.kind === 'deterministic' ? station.command : station.model;
  if (station.role !== undefined && worker !== undefined) return `${station.role} / ${worker}`;
  if (station.role !== undefined) return station.role;
  if (worker !== undefined) return worker;
  return 'none';
}

function describeFanInCompact(policy: number | FanInPolicyConfig, fanOut?: number): string {
  if (typeof policy === 'number') return fanOut !== undefined ? `${policy}/${fanOut}` : `survivors >= ${policy}`;
  switch (policy.policy) {
    case 'quorum':
      return fanOut !== undefined ? `${policy.k}/${fanOut}` : `quorum ${policy.k}`;
    case 'all':
      return fanOut !== undefined ? `all ${fanOut}` : 'all';
    case 'best_effort':
      return 'best effort';
  }
}

function stationDisplayLabel(flow: FlowConfig, id: string, fanOutForJoin?: number): string {
  const station = flow.stations[id];
  const name = humanizeLane(id);
  if (station === undefined) return name;
  if (station.fan_out !== undefined) return `${name} [split x${station.fan_out}]`;
  if (station.fan_in !== undefined) return `${name} [join ${describeFanInCompact(station.fan_in, fanOutForJoin)}]`;
  if (station.rankCheck) return `${name} [rank]`;
  if (station.gateCheck) return `${name} [gate]`;
  return name;
}

function laneDisplayLabel(
  flow: FlowConfig,
  lane: string,
  fanOutByJoin: ReadonlyMap<string, number>,
  colors: Colors,
): string {
  if (isTerminalLane(flow, lane)) return colors.green(humanizeLane(lane));

  const station = flow.stations[lane];
  const label = stationDisplayLabel(flow, lane, fanOutByJoin.get(lane));
  if (station?.fan_out !== undefined) return colors.magenta(label);
  if (station?.fan_in !== undefined) return colors.magenta(label);
  if (station?.rankCheck !== undefined) return colors.magenta(label);
  if (station?.gateCheck !== undefined) return colors.yellow(label);
  return colors.cyan(label);
}

function backEdgeReason(flow: FlowConfig, from: string): string {
  const gate = flow.stations[from]?.gateCheck;
  const label = gate?.criticRole ?? gate?.criticModel;
  return label !== undefined && label.length > 0 ? label : 'reject';
}

function reworkTargets(
  flow: FlowConfig,
  lane: string,
  backEdgeScope?: ReadonlySet<string>,
): string[] {
  return (flow.back_edges ?? [])
    .filter((edge) => edge.from === lane)
    .filter((edge) => backEdgeScope === undefined || backEdgeScope.has(edge.to))
    .map((edge) => edge.to);
}

function boxSubtitle(flow: FlowConfig, lane: string): string {
  if (isTerminalLane(flow, lane)) return '';
  return flow.stations[lane]?.role ?? '';
}

function nodeBox(label: string, subtitle: string | undefined, targets: string[], colors: Colors): string[] {
  const uniqueTargets = Array.from(new Set(targets)).map(humanizeLane);
  const rework = uniqueTargets.length > 0 ? colors.red(`${GLYPH.rework} ${uniqueTargets.join(', ')}`) : '';
  const caption = subtitle !== undefined && subtitle.length > 0 ? colors.dim(subtitle) : '';
  const bodyRows = subtitle === undefined ? [label, rework] : [label, caption, rework];
  const innerWidth = Math.max(...bodyRows.map(visibleLength), 6);
  return [
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...bodyRows.map((rowText) => `│ ${padVisible(rowText, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
  ];
}

function joinBoxes(boxes: string[][]): string[] {
  const height = Math.max(0, ...boxes.map((box) => box.length));
  const lines = Array.from({ length: height }, () => '');
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    const hasNext = i < boxes.length - 1;
    for (let row = 0; row < lines.length; row++) {
      const connector = hasNext ? (row === 1 ? '──▶' : '   ') : '';
      lines[row] += `${box[row] ?? ''}${connector}`;
    }
  }
  return lines;
}

interface BoxedChainOptions {
  fanOutByJoin?: ReadonlyMap<string, number>;
  backEdgeScope?: ReadonlySet<string>;
  perLine?: number;
  showSubtitle?: boolean;
}

function renderBoxedChain(
  flow: FlowConfig,
  lanes: string[],
  colors: Colors,
  opts: BoxedChainOptions = {},
): string[] {
  const lines: string[] = [];
  const fanOutByJoin = opts.fanOutByJoin ?? new Map<string, number>();
  const rows = chunk(lanes, opts.perLine ?? 3);

  rows.forEach((row, index) => {
    const boxes = row.map((lane) => nodeBox(
      laneDisplayLabel(flow, lane, fanOutByJoin, colors),
      opts.showSubtitle === true ? boxSubtitle(flow, lane) : undefined,
      reworkTargets(flow, lane, opts.backEdgeScope),
      colors,
    ));
    lines.push(...joinBoxes(boxes));
    if (index < rows.length - 1) {
      lines.push('  │');
      lines.push('  ▼');
    }
  });

  return lines;
}

function laneCenterColumn(
  flow: FlowConfig,
  lanes: string[],
  targetLane: string,
  colors: Colors,
  opts: BoxedChainOptions = {},
): number {
  const perLine = opts.perLine ?? 3;
  const targetIndex = lanes.lastIndexOf(targetLane);
  if (targetIndex < 0) return 0;

  const fanOutByJoin = opts.fanOutByJoin ?? new Map<string, number>();
  const rowStart = Math.floor(targetIndex / perLine) * perLine;
  const row = lanes.slice(rowStart, rowStart + perLine);
  let column = 0;

  for (const lane of row) {
    const box = nodeBox(
      laneDisplayLabel(flow, lane, fanOutByJoin, colors),
      opts.showSubtitle === true ? boxSubtitle(flow, lane) : undefined,
      reworkTargets(flow, lane, opts.backEdgeScope),
      colors,
    );
    const width = visibleLength(box[0] ?? '');

    if (lane === targetLane) return column + Math.floor(width / 2);
    column += width + 3;
  }

  return 0;
}

function renderFramedBlock(title: string, bodyLines: string[], firstPrefix: string, bodyPrefix: string): string[] {
  const titleText = ` ${title} `;
  const maxBodyWidth = Math.max(0, ...bodyLines.map(visibleLength));
  const innerWidth = Math.max(maxBodyWidth, visibleLength(titleText) + 2);
  const topTitle = `─${titleText}`;
  const topInside = `${topTitle}${'─'.repeat(Math.max(0, innerWidth + 2 - visibleLength(topTitle)))}`;

  return [
    `${firstPrefix}╭${topInside}╮`,
    ...bodyLines.map((line) => `${bodyPrefix}│ ${padVisible(line, innerWidth)} │`),
    `${bodyPrefix}╰${'─'.repeat(innerWidth + 2)}╯`,
  ];
}

function collectLaneChain(flow: FlowConfig, start: string, blockedStations: ReadonlySet<string>): string[] {
  const lanes: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    lanes.push(current);

    if (isTerminalLane(flow, current)) break;
    if (blockedStations.has(current) && current !== start) break;

    current = successorOf(flow, current);
  }

  return lanes;
}

function renderFlowOverviewRich(flow: FlowConfig, colors: Colors): string {
  const { mainIds, childPaths } = partition(flow);
  const fanOutByJoin = new Map<string, number>();
  const childIds = new Set<string>();

  for (const path of childPaths) {
    for (const id of path.ids) childIds.add(id);
    if (path.joinAt !== undefined) fanOutByJoin.set(path.joinAt, path.count);
  }

  if (mainIds.length === 0) return '';
  if (childPaths.length === 0) return `${renderBoxedChain(flow, mainIds, colors).join('\n')}\n`;

  const lines: string[] = [];
  const renderedParents = new Set<string>();

  for (const path of childPaths) {
    if (renderedParents.has(path.parent)) continue;
    renderedParents.add(path.parent);

    const parentIndex = mainIds.indexOf(path.parent);
    const prefix = parentIndex >= 0 ? mainIds.slice(0, parentIndex + 1) : [path.parent];
    lines.push(...renderBoxedChain(flow, prefix, colors));

    const branchColumn = laneCenterColumn(flow, prefix, path.parent, colors);
    const branchIndent = ' '.repeat(branchColumn);
    lines.push(colors.dim(`${branchIndent}${GLYPH.v}`));

    const childLane = path.childTerminal !== undefined ? [...path.ids, path.childTerminal] : path.ids;
    const childBackEdgeScope = new Set(childLane);
    lines.push(...renderFramedBlock(
      colors.magenta(`child lane x${path.count} / spawn x${path.count}`),
      renderBoxedChain(flow, childLane, colors, { backEdgeScope: childBackEdgeScope, showSubtitle: true }),
      `${branchIndent}├─`,
      `${branchIndent}${GLYPH.v} `,
    ));

    if (path.joinAt !== undefined) {
      const afterJoin = collectLaneChain(flow, path.joinAt, childIds);
      lines.push(...renderFramedBlock(
        colors.magenta('join survivors'),
        renderBoxedChain(flow, afterJoin, colors, { fanOutByJoin }),
        `${branchIndent}└─`,
        `${branchIndent}  `,
      ));
    }
  }

  return `${lines.join('\n')}\n`;
}

function routeSummary(flow: FlowConfig, id: string): string {
  const station = flow.stations[id]!;
  if (station.fan_out !== undefined) {
    const childEntry = station.child_entry ?? '?';
    const join = station.resume_at ?? 'unknown';
    return `split x${station.fan_out} -> ${childEntry}; join ${join}`;
  }

  const next = successorOf(flow, id);
  return next === null ? 'no next' : `-> ${next}`;
}

function noteSummary(station: StationConfig): string {
  const notes: string[] = [];
  if (station.fan_in !== undefined) notes.push(`fan-in ${describeFanIn(station.fan_in)}`);
  if (station.gateCheck) notes.push(`reject -> ${station.gateCheck.onReject}`);
  if (station.rankCheck) notes.push(station.rankCheck.hitlEnabled ? 'HITL rank' : 'rank no-HITL');
  if (station.effectful) notes.push('effectful');
  if (station.overlap === true) notes.push('overlap');
  if (station.child_terminal !== undefined) notes.push(`child terminal ${station.child_terminal}`);
  return notes.join(', ') || '-';
}

function renderStationTableRich(flow: FlowConfig, colors: Colors, harnessRegistry?: HarnessRegistry): string {
  const rows = [
    [
      colors.bold('station'),
      colors.bold('kind'),
      colors.bold('worker'),
      colors.bold('route'),
      colors.bold('notes'),
    ],
    ...Object.entries(flow.stations).map(([id, station]) => {
      const notes = noteSummary(station);
      const extra = harnessDetails(station, harnessRegistry);
      return [
        colors.cyan(id),
        station.rankCheck ? colors.magenta(stationKindLabel(station)) : colors.yellow(stationKindLabel(station)),
        workerLabel(station),
        routeSummary(flow, id),
        extra.length > 0 ? [...(notes === '-' ? [] : [notes]), ...extra].join(', ') : notes,
      ];
    }),
  ];

  return table(rows, {
    columns: {
      0: { width: 16, wrapWord: true },
      1: { width: 15, wrapWord: true },
      2: { width: 26, wrapWord: true },
      3: { width: 30, wrapWord: true },
      4: { width: 34, wrapWord: true },
    },
  });
}

function renderBackflowTableRich(flow: FlowConfig, colors: Colors): string | null {
  const edges = flow.back_edges ?? [];
  if (edges.length === 0) return null;

  const { childPaths } = partition(flow);
  const rows = [
    [
      colors.bold('from'),
      colors.bold('to'),
      colors.bold('reason'),
      colors.bold('scope'),
    ],
    ...edges.map((edge) => {
      const childPath = childPaths.find((path) =>
        path.ids.includes(edge.from) &&
        (path.ids.includes(edge.to) || path.childTerminal === edge.to),
      );
      return [
        colors.cyan(edge.from),
        colors.cyan(edge.to),
        backEdgeReason(flow, edge.from),
        childPath === undefined ? 'mission' : `${childPath.parent} child lane`,
      ];
    }),
  ];

  return table(rows, {
    columns: {
      0: { width: 14, wrapWord: true },
      1: { width: 14, wrapWord: true },
      2: { width: 24, wrapWord: true },
      3: { width: 22, wrapWord: true },
    },
  });
}

/** Build the rich compact topology explanation. */
function renderRich(flow: FlowConfig, color: boolean, harnessRegistry?: HarnessRegistry): string {
  const colors = pc.createColors(color);
  const lines = [
    colors.bold(renderHeader(flow)),
    '',
    colors.bold('Flow'),
    renderFlowOverviewRich(flow, colors).replace(/\n$/, ''),
    '',
    colors.bold('Stations'),
    renderStationTableRich(flow, colors, harnessRegistry).replace(/\n$/, ''),
  ];

  const backflowTable = renderBackflowTableRich(flow, colors);
  if (backflowTable !== null) {
    lines.push('', colors.bold('Backflow'), backflowTable.replace(/\n$/, ''));
  }

  lines.push('', `${colors.dim('terminals:')} ${(flow.terminal_lanes ?? DEFAULT_TERMINALS).join(` ${GLYPH.dot} `)}`);
  return lines.join('\n');
}
