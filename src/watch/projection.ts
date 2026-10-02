/**
 * The War Room projection (issue #89, PRD §8): the one place view state is
 * derived from the journal.
 *
 * Two pure steps:
 *
 *   foldEvents(fold, events) → fold     accumulate journal rows
 *   deriveView(fold, input)  → WatchView  apply the run context, the state DB
 *                                         snapshot and the clock
 *
 * Live and replay are the same two calls. Live folds each poll's rows onto the
 * previous fold; replay folds a prefix of the recorded rows onto `emptyFold()`.
 * `foldEvents` never mutates its input fold, and folding N rows in one call
 * gives the same fold as N one-row calls (PRD §10, the burst risk).
 *
 * The three journal tables share no sequence (schema gap `cross-table-order`),
 * so the reader's interleaving of them differs between a live session and a
 * restart. The fold is built so the view does not depend on it: each field
 * reads from one table only, in that table's id order, and anything compared
 * across tables (the ticker, the newest activity) is chosen by timestamp.
 *
 * The prototype this replaces (design/warroom-prototype/lib/warroom-data.ts)
 * hard-coded caps, budgets, owned paths and the card list. Here caps and
 * budgets come from the flow (`WatchContext`), card identity from the state DB,
 * and every value neither records renders as "not recorded" with its gap named
 * in `WatchView.gaps`.
 */

import type { CardSnapshot, RateLimitWindowReading, RunSnapshot, StateSnapshot, WatchEvent } from './events';
import { JOURNAL_SCHEMA_GAPS, type SchemaGapId } from './schema-gaps';

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export interface Visit {
  station: string;
  /** The card_log reason_class of the move into this lane; null when not recorded. */
  reasonClass: string | null;
}

export interface LastTool {
  name: string | null;
  path: string | null;
  exitCode: number | null;
  isError: boolean | null;
  /** True between a tool-input-available row and its tool-output-available row. */
  running: boolean;
}

export interface CardFold {
  id: string;
  /** Lanes entered, in card_log order. */
  visits: Visit[];
  /** The newest lane from card_log; null when the card has no entered_lane row. */
  lane: string | null;
  /** Attempt of the newest card_log row. */
  attempt: number | null;
  /** Rework moves, keyed by the gate station that rejected. */
  reworksByGate: Record<string, number>;
  lastVerdict: { verdict: string | null; findings: string[] | null } | null;
  terminalReason: string | null;
  tokens: number;
  costUsd: number;
  /** Spans that reported usage as unknown (WI-567). */
  usageUnknownSpans: number;
  /** Newest span created_at for this card, epoch seconds. */
  lastSpanAt: number | null;
  /** From the newest `hitl.held_at` span. */
  heldAt: number | null;
  /** The newest journal span name, e.g. `implement.harness`. */
  lastSpanName: string | null;
  lastTool: LastTool | null;
}

export interface Ticker {
  cardId: string;
  text: string;
  /** Epoch milliseconds. */
  atMs: number;
  source: WatchEvent['source'];
  id: number;
}

export interface Fold {
  cards: Record<string, CardFold>;
  /** Stations in order of first appearance in card_log. */
  stationsSeen: string[];
  eventCount: number;
  runTokens: number;
  runCostUsd: number;
  /** Newest journal span created_at, epoch seconds. */
  newestSpanAt: number | null;
  /** Newest harness event at_ms. */
  newestHarnessAtMs: number | null;
  /** The five_hour window from the newest rate-limit row that carried one. */
  quota: { utilization: number; resetsAtMs: number | null; atMs: number } | null;
  /** The newest timestamped row, for the footer ticker. */
  ticker: Ticker | null;
}

export function emptyFold(): Fold {
  return {
    cards: {},
    stationsSeen: [],
    eventCount: 0,
    runTokens: 0,
    runCostUsd: 0,
    newestSpanAt: null,
    newestHarnessAtMs: null,
    quota: null,
    ticker: null,
  };
}

function emptyCard(id: string): CardFold {
  return {
    id,
    visits: [],
    lane: null,
    attempt: null,
    reworksByGate: {},
    lastVerdict: null,
    terminalReason: null,
    tokens: 0,
    costUsd: 0,
    usageUnknownSpans: 0,
    lastSpanAt: null,
    heldAt: null,
    lastSpanName: null,
    lastTool: null,
  };
}

/** Later wins: by time, then source, then row id. Independent of arrival order. */
function newerTicker(a: Ticker | null, b: Ticker): Ticker {
  if (a === null) return b;
  if (b.atMs !== a.atMs) return b.atMs > a.atMs ? b : a;
  if (b.source !== a.source) return b.source > a.source ? b : a;
  return b.id > a.id ? b : a;
}

const QUOTA_WINDOW = 'five_hour';

/**
 * Fold journal rows onto `fold`. Returns a new fold; `fold` is not modified.
 * Rows of one table must arrive in that table's id order, which the reader
 * guarantees; rows of different tables may interleave in any order.
 */
export function foldEvents(fold: Fold, events: readonly WatchEvent[]): Fold {
  if (events.length === 0) return fold;
  const next: Fold = {
    ...fold,
    cards: { ...fold.cards },
    stationsSeen: [...fold.stationsSeen],
  };
  // Copy a card at most once per call, so a burst costs O(rows), not O(rows × cards).
  const copied = new Set<string>();
  const card = (id: string): CardFold => {
    const existing = next.cards[id];
    if (existing === undefined) {
      const created = emptyCard(id);
      next.cards[id] = created;
      copied.add(id);
      return created;
    }
    if (!copied.has(id)) {
      const clone: CardFold = {
        ...existing,
        visits: [...existing.visits],
        reworksByGate: { ...existing.reworksByGate },
      };
      next.cards[id] = clone;
      copied.add(id);
      return clone;
    }
    return existing;
  };

  for (const ev of events) {
    next.eventCount += 1;
    const c = card(ev.cardId);
    switch (ev.source) {
      case 'card_log': {
        c.attempt = ev.attempt;
        if (ev.kind === 'entered_lane') {
          const dest = ev.destLane ?? null;
          if (dest !== null) {
            c.visits.push({ station: dest, reasonClass: ev.reasonClass });
            c.lane = dest;
            if (!next.stationsSeen.includes(dest)) next.stationsSeen.push(dest);
          }
          if (ev.reasonClass === 'rework') {
            c.reworksByGate[ev.station] = (c.reworksByGate[ev.station] ?? 0) + 1;
          }
        } else if (ev.kind === 'gate_verdict') {
          c.lastVerdict = { verdict: ev.verdict, findings: ev.findings };
        } else if (ev.kind === 'terminal') {
          c.terminalReason = ev.reason;
        }
        break;
      }
      case 'journal': {
        if (ev.tokens !== null) {
          c.tokens += ev.tokens;
          next.runTokens += ev.tokens;
        }
        if (ev.costUsd !== null) {
          c.costUsd += ev.costUsd;
          next.runCostUsd += ev.costUsd;
        }
        if (ev.usageUnknown) c.usageUnknownSpans += 1;
        c.lastSpanName = ev.name;
        if (ev.name === 'hitl.held_at') {
          const heldAt = ev.attributes.held_at;
          c.heldAt = typeof heldAt === 'number' ? heldAt : c.heldAt;
        }
        if (ev.createdAt !== null) {
          c.lastSpanAt = Math.max(c.lastSpanAt ?? ev.createdAt, ev.createdAt);
          next.newestSpanAt = Math.max(next.newestSpanAt ?? ev.createdAt, ev.createdAt);
          next.ticker = newerTicker(next.ticker, {
            cardId: ev.cardId,
            text: `${ev.station}@${ev.attempt} ${ev.name}`,
            atMs: ev.createdAt * 1000,
            source: 'journal',
            id: ev.id,
          });
        }
        break;
      }
      case 'harness': {
        if (ev.kind === 'tool-input-available') {
          c.lastTool = { name: ev.toolName, path: ev.path, exitCode: null, isError: null, running: true };
        } else if (ev.kind === 'tool-output-available') {
          c.lastTool = {
            name: ev.toolName ?? c.lastTool?.name ?? null,
            path: ev.path ?? c.lastTool?.path ?? null,
            exitCode: ev.exitCode,
            isError: ev.isError,
            running: false,
          };
        } else if (ev.kind === 'rate-limit' && ev.rateLimitWindows !== null && ev.atMs !== null) {
          const window: RateLimitWindowReading | undefined = ev.rateLimitWindows.find((w) => w.name === QUOTA_WINDOW);
          if (window !== undefined && (next.quota === null || ev.atMs >= next.quota.atMs)) {
            next.quota = { utilization: window.utilization, resetsAtMs: window.resetsAtMs, atMs: ev.atMs };
          }
        }
        if (ev.atMs !== null) {
          next.newestHarnessAtMs = Math.max(next.newestHarnessAtMs ?? ev.atMs, ev.atMs);
          const tool = ev.toolName !== null ? ` ${ev.toolName}${ev.path !== null ? ` ${ev.path}` : ''}` : '';
          next.ticker = newerTicker(next.ticker, {
            cardId: ev.cardId,
            text: `${ev.station}@${ev.attempt} ${ev.kind}${tool}`,
            atMs: ev.atMs,
            source: 'harness',
            id: ev.id,
          });
        }
        break;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** What the flow file says about the run. Null fields were not readable. */
export interface WatchContext {
  /** Station ids in flow order; station hues are assigned by this index. */
  stations: string[];
  /** Station id → kind, for the stations the flow declares. */
  stationKinds: Record<string, string>;
  wallClockSec: number | null;
  maxTokens: number | null;
  /** Liveness watchdog threshold (budgets.liveness.no_progress_minutes). */
  livenessSec: number | null;
  /** Gate station id → rework_cap. */
  reworkCaps: Record<string, number>;
  /** budgets.per_card.max_execution_attempts. */
  maxAttempts: number | null;
  /** False when the flow file could not be read (schema gap `flow-at-run`). */
  flowLoaded: boolean;
}

export type WatchMode = 'live' | 'replay';

export interface DeriveInput {
  runId: string;
  mode: WatchMode;
  context: WatchContext;
  /**
   * The state DB. In live mode its lane and status are the current truth. In
   * replay only its static fields (parent, owned paths, card order) are used,
   * because the state DB holds the present, not the scrub position.
   */
  snapshot: StateSnapshot | null;
  /** Epoch seconds. Ignored in replay, where now is the newest folded timestamp. */
  nowSec: number;
}

/**
 * A header meter. `fraction` null means "not recorded", unless `inactive` is
 * set: then the meter does not apply right now and renders as plain text.
 */
export interface Meter {
  fraction: number | null;
  /** The value text shown after the bar. */
  text: string;
  inactive?: boolean;
}

export type RowState =
  | 'working'
  | 'ready'
  | 'parked'
  | 'waiting'
  | 'interrupted'
  | 'awaiting'
  | 'held'
  | 'done'
  | 'scrap'
  /** Replay, or a card missing from the state DB: the lane is known, its status is not. */
  | 'lane'
  | 'unknown';

export interface RowView {
  id: string;
  parentId: string | null;
  depth: number;
  /** True for the last child under its parent, for the └─ glyph. */
  lastSibling: boolean;
  /** The card's current lane; null when neither the state DB nor card_log records one. */
  lane: string | null;
  /** Index of `lane` in the run's station order; null for a terminal or unknown lane. */
  stationIndex: number | null;
  state: RowState;
  /** Short state column text. */
  stateToken: string;
  /** Seconds the current worker has held the card (live only). */
  workingForSec: number | null;
  /** Seconds since the card was held (from hitl.held_at). */
  heldForSec: number | null;
  attempt: number | null;
  maxAttempts: number | null;
  /** Reworks at the gate that rejected this card most often. */
  reworks: number;
  reworkCap: number | null;
  tokens: number;
  costUsd: number;
  visits: { stationIndex: number | null; station: string; rework: boolean }[];
  ownedPaths: string[];
  lastVerdict: CardFold['lastVerdict'];
  terminalReason: string | null;
  lastTool: LastTool | null;
  lastSpanName: string | null;
  /** True when the card sits at a deterministic station, which writes no span. */
  deterministicStation: boolean;
}

export interface Tallies {
  working: number;
  waiting: number;
  held: number;
  done: number;
  scrap: number;
}

export interface WatchView {
  runId: string;
  mode: WatchMode;
  /** Seconds since the run started; null when not recorded. */
  elapsedSec: number | null;
  /** True when elapsed is a lower bound (a stopped run has no end time). */
  elapsedIsLowerBound: boolean;
  runStatus: string | null;
  wall: Meter;
  tokens: Meter;
  quota: Meter;
  watchdog: Meter;
  tallies: Tallies;
  stations: string[];
  rows: RowView[];
  ticker: Ticker | null;
  /** Journal rows folded into this view. */
  eventCount: number;
  /** Schema gaps this view rendered as "not recorded", in catalogue order. */
  gaps: SchemaGapId[];
}

const NOT_RECORDED = 'not recorded';
const TERMINALS = new Set(['done', 'scrap', 'hold', 'intake']);

/** Format seconds as m:ss below an hour and h:mm:ss above. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Format a token count compactly: 950, 12.4k, 1.20M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function ratio(value: number, cap: number | null): number | null {
  if (cap === null || cap <= 0) return null;
  return Math.max(0, value / cap);
}

function liveState(card: CardSnapshot, nowSec: number): RowState {
  if (card.status === 'complete' || card.lane === 'done') return 'done';
  if (card.status === 'scrapped' || card.lane === 'scrap') return 'scrap';
  if (card.status === 'held' || card.lane === 'hold') return 'held';
  switch (card.status) {
    case 'awaiting_children':
      return 'awaiting';
    case 'claimed':
    case 'working':
    case 'done_pending_ack':
      return 'working';
    case 'ready':
      return card.releaseAt !== null && card.releaseAt > nowSec ? 'parked' : 'ready';
    case 'waiting':
      return 'waiting';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

function replayState(fold: CardFold | undefined): RowState {
  if (fold === undefined || fold.lane === null) return 'unknown';
  if (fold.lane === 'done') return 'done';
  if (fold.lane === 'scrap') return 'scrap';
  if (fold.lane === 'hold') return 'held';
  return 'lane';
}

function stateToken(state: RowState, row: Pick<RowView, 'workingForSec' | 'heldForSec' | 'terminalReason'>): string {
  switch (state) {
    case 'working':
      return row.workingForSec !== null ? formatDuration(row.workingForSec) : 'working';
    case 'ready':
      return 'ready';
    case 'parked':
      return 'parked';
    case 'waiting':
      return 'waiting';
    case 'interrupted':
      return 'interrupted';
    case 'awaiting':
      return 'awaiting';
    case 'held':
      return row.heldForSec !== null ? `HELD ${formatDuration(row.heldForSec)}` : 'HELD';
    case 'done':
      return '✓';
    case 'scrap':
      return 'SCRAP';
    case 'lane':
      return 'lane';
    case 'unknown':
      return '?';
  }
}

/** Order cards as a tree: parents first, children beneath, otherwise by first sight. */
function treeOrder(ids: string[], parentOf: Map<string, string | null>): { id: string; depth: number; lastSibling: boolean }[] {
  const known = new Set(ids);
  const children = new Map<string | null, string[]>();
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    const key = parent !== null && known.has(parent) ? parent : null;
    const list = children.get(key) ?? [];
    list.push(id);
    children.set(key, list);
  }
  const out: { id: string; depth: number; lastSibling: boolean }[] = [];
  const visit = (parent: string | null, depth: number): void => {
    const kids = children.get(parent) ?? [];
    kids.forEach((id, i) => {
      out.push({ id, depth, lastSibling: i === kids.length - 1 });
      visit(id, depth + 1);
    });
  };
  visit(null, 0);
  return out;
}

/**
 * The liveness watchdog meter, built from the conditions the kernel's
 * `checkLiveness` (src/control/watchdog.ts) trips on, so it fills only when
 * the kernel could declare a stall:
 *
 *   - a worker holds a card (status claimed/working/done_pending_ack, or an
 *     active_workers row): no trip, the meter reads "worker active";
 *   - a ready card is gated behind release_at >= now (the kernel's
 *     hasReleaseGatedCards): no trip, the meter reads "waiting";
 *   - otherwise it fills with the age of the newest journal span against
 *     no_progress_minutes.
 *
 * A harness maker writes its span only when the call returns, so span age
 * alone would climb through every long healthy call. The kernel's other
 * progress input, the time of the last lane change, is not recorded
 * (`card-log-timestamp`), so span age is the only progress clock available.
 * Replay has no state DB for the past, so it renders "not recorded".
 */
function watchdogMeter(fold: Fold, input: DeriveInput, snapshot: StateSnapshot | null, gaps: Set<SchemaGapId>): Meter {
  if (input.mode === 'replay' || snapshot === null) {
    gaps.add('worker-activity-history');
    return { fraction: null, text: NOT_RECORDED };
  }
  const run = snapshot.run;
  if (run !== null && run.status !== 'running') {
    return { fraction: null, text: `run ${run.status}`, inactive: true };
  }
  const now = input.nowSec;
  const working = snapshot.cards.some(
    (c) => c.workerStartedAt !== null || c.status === 'claimed' || c.status === 'working' || c.status === 'done_pending_ack',
  );
  if (working) return { fraction: null, text: 'worker active', inactive: true };
  const gated = snapshot.cards.some((c) => c.status === 'ready' && c.releaseAt !== null && c.releaseAt >= now);
  if (gated) return { fraction: null, text: 'waiting', inactive: true };
  if (fold.newestSpanAt === null) return { fraction: null, text: NOT_RECORDED };
  const age = Math.max(0, now - fold.newestSpanAt);
  return { fraction: ratio(age, input.context.livenessSec), text: formatDuration(age) };
}

export function deriveView(fold: Fold, input: DeriveInput): WatchView {
  const { context, snapshot, mode } = input;
  const gaps = new Set<SchemaGapId>(['card-log-timestamp', 'kernel-heartbeat']);
  if (mode === 'replay') {
    gaps.add('cross-table-order');
    gaps.add('status-history');
  }
  if (!context.flowLoaded) gaps.add('flow-at-run');

  // Replay's clock is the newest timestamp it has folded, so every header
  // value rolls back with the scrub position.
  const newestAtSec = Math.max(
    fold.newestSpanAt ?? -Infinity,
    fold.newestHarnessAtMs !== null ? Math.floor(fold.newestHarnessAtMs / 1000) : -Infinity,
  );
  const newestSec = Number.isFinite(newestAtSec) ? newestAtSec : null;
  const nowSec = mode === 'live' ? input.nowSec : newestSec;

  const stations = [...context.stations];
  for (const s of fold.stationsSeen) {
    if (!TERMINALS.has(s) && !stations.includes(s)) stations.push(s);
  }
  const indexOf = (lane: string | null): number | null => {
    if (lane === null) return null;
    const i = stations.indexOf(lane);
    return i === -1 ? null : i;
  };

  // ── Elapsed / wall meter ───────────────────────────────────────────────
  const run: RunSnapshot | null = snapshot?.run ?? null;
  let elapsedSec: number | null = null;
  let elapsedIsLowerBound = false;
  if (run !== null && run.createdAt > 0) {
    if (mode === 'live' && run.status === 'running') {
      elapsedSec = input.nowSec - run.createdAt;
    } else if (newestSec !== null) {
      // A stopped run records no end time: the newest folded row is a lower
      // bound. In replay the newest folded row is the scrub position itself.
      elapsedSec = newestSec - run.createdAt;
      if (mode === 'live') {
        elapsedIsLowerBound = true;
        gaps.add('run-end-time');
      }
    }
  }
  const wallFraction = elapsedSec !== null ? ratio(elapsedSec, context.wallClockSec) : null;
  const wall: Meter = {
    fraction: wallFraction,
    text:
      wallFraction !== null
        ? `${Math.round(wallFraction * 100)}%`
        : elapsedSec !== null
          ? 'no budget'
          : NOT_RECORDED,
  };

  const tokenFraction = ratio(fold.runTokens, context.maxTokens);
  const tokens: Meter = {
    fraction: tokenFraction,
    text: tokenFraction !== null ? `${Math.round(tokenFraction * 100)}%` : `${formatTokens(fold.runTokens)} no budget`,
  };

  let quota: Meter;
  if (fold.quota !== null) {
    quota = { fraction: fold.quota.utilization, text: `${Math.round(fold.quota.utilization * 100)}%` };
  } else {
    quota = { fraction: null, text: NOT_RECORDED };
    gaps.add('plan-quota');
  }

  const watchdog = watchdogMeter(fold, input, snapshot, gaps);

  // ── Rows ───────────────────────────────────────────────────────────────
  const snapCards = new Map<string, CardSnapshot>((snapshot?.cards ?? []).map((c) => [c.id, c]));
  const ids = [...snapCards.keys()];
  for (const id of Object.keys(fold.cards).sort()) {
    if (!snapCards.has(id)) ids.push(id);
  }
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, snapCards.get(id)?.parentId ?? null]));
  if (ids.length > 0) gaps.add('card-title');

  const tallies: Tallies = { working: 0, waiting: 0, held: 0, done: 0, scrap: 0 };
  const rows: RowView[] = treeOrder(ids, parentOf).map(({ id, depth, lastSibling }) => {
    const f = fold.cards[id];
    const snap = snapCards.get(id);
    const useSnap = mode === 'live' && snap !== undefined;
    const lane = useSnap ? snap.lane : (f?.lane ?? null);
    const state = useSnap ? liveState(snap, input.nowSec) : replayState(f);
    if (mode === 'live' && snap === undefined) gaps.add('status-history');

    const workingForSec =
      useSnap && state === 'working' && snap.workerStartedAt !== null ? Math.max(0, input.nowSec - snap.workerStartedAt) : null;
    const heldForSec = state === 'held' && f?.heldAt != null && nowSec !== null ? Math.max(0, nowSec - f.heldAt) : null;
    if (state === 'held') gaps.add('hold-timeout-policy');

    let reworks = 0;
    let reworkCap: number | null = null;
    for (const [gate, n] of Object.entries(f?.reworksByGate ?? {})) {
      if (n > reworks) {
        reworks = n;
        reworkCap = context.reworkCaps[gate] ?? null;
      }
    }
    if (reworks === 0 && lane !== null) reworkCap = context.reworkCaps[lane] ?? null;

    const deterministicStation = lane !== null && context.stationKinds[lane] === 'deterministic';
    if (deterministicStation && (state === 'working' || state === 'ready')) gaps.add('deterministic-span');

    switch (state) {
      case 'working':
        tallies.working += 1;
        break;
      case 'held':
        tallies.held += 1;
        break;
      case 'done':
        tallies.done += 1;
        break;
      case 'scrap':
        tallies.scrap += 1;
        break;
      case 'ready':
      case 'parked':
      case 'waiting':
      case 'interrupted':
        tallies.waiting += 1;
        break;
      default:
        break;
    }

    const base = { workingForSec, heldForSec, terminalReason: f?.terminalReason ?? null };
    return {
      id,
      parentId: parentOf.get(id) ?? null,
      depth,
      lastSibling,
      lane,
      stationIndex: indexOf(lane),
      state,
      stateToken: stateToken(state, base),
      ...base,
      attempt: useSnap ? snap.attempt : (f?.attempt ?? null),
      maxAttempts: context.maxAttempts,
      reworks,
      reworkCap,
      tokens: f?.tokens ?? 0,
      costUsd: f?.costUsd ?? 0,
      visits: (f?.visits ?? [])
        .filter((v) => !TERMINALS.has(v.station))
        .map((v) => ({ station: v.station, stationIndex: indexOf(v.station), rework: v.reasonClass === 'rework' })),
      ownedPaths: snap?.ownedPaths ?? [],
      lastVerdict: f?.lastVerdict ?? null,
      lastTool: f?.lastTool ?? null,
      lastSpanName: f?.lastSpanName ?? null,
      deterministicStation,
    };
  });

  return {
    runId: input.runId,
    mode,
    elapsedSec,
    elapsedIsLowerBound,
    runStatus: run?.status ?? null,
    wall,
    tokens,
    quota,
    watchdog,
    tallies,
    stations,
    rows,
    ticker: fold.ticker,
    eventCount: fold.eventCount,
    gaps: JOURNAL_SCHEMA_GAPS.map((g) => g.id).filter((id) => gaps.has(id)),
  };
}

/** Replay: the view at `position` rows into the recorded stream (PRD §8). */
export function replay(events: readonly WatchEvent[], position: number, input: Omit<DeriveInput, 'mode'>): WatchView {
  const prefix = events.slice(0, Math.max(0, Math.min(position, events.length)));
  return deriveView(foldEvents(emptyFold(), prefix), { ...input, mode: 'replay' });
}
