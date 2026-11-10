/**
 * The War Room's input types (issue #89): journal rows as the reader hands
 * them to the projection, and the state DB snapshot.
 *
 * These replace the June prototype's `JournalEvent` (design/warroom-prototype/
 * lib/warroom-data.ts), which modelled one table of FSM events (CLAIM,
 * START_WORK, MARK_DONE, QC_REJECT, ...) each carrying a time, a lane pair,
 * tokens and cost. The real journal is three tables with their own ids:
 *
 *   - card_log: lane changes, gate verdicts, terminals and skips, with no time
 *     column (schema gap `card-log-timestamp`);
 *   - journal: spans, which carry the token and cost columns and `created_at`
 *     in epoch seconds;
 *   - harness_events: per-call tool, usage, rate-limit and lifecycle rows with
 *     `at_ms`.
 *
 * There is no sequence shared by the three (schema gap `cross-table-order`),
 * so each event keeps its source table and that table's row id, which is the
 * reader's follow cursor. Every field a row may lack, because an older journal
 * predates its column, is nullable here and read as "not recorded".
 */

import type { Status } from '../types/kernel';
import type { ReasonClass } from '../persistence/db';

/** Which journal table an event was read from. */
export type EventSource = 'card_log' | 'journal' | 'harness';

interface EventBase {
  /** The row id in its own table: the follow cursor for that table. */
  id: number;
  cardId: string;
  station: string;
  attempt: number;
}

export type CardLogEvent = EventBase & { source: 'card_log' } & (
    | {
        kind: 'entered_lane';
        sourceLane: string | null;
        destLane: string | null;
        /** Null when the row has none; an unknown value is kept as written. */
        reasonClass: ReasonClass | string | null;
      }
    | { kind: 'gate_verdict'; verdict: string | null; findings: string[] | null; returnTo: string | null }
    | { kind: 'terminal'; reason: string | null }
    | { kind: 'skip'; reason: string | null }
    /** A card_log kind this reader does not know. Folded as a no-op. */
    | { kind: 'other'; rawKind: string }
  );

export interface JournalSpanEvent extends EventBase {
  source: 'journal';
  name: string;
  /** Epoch seconds. */
  createdAt: number | null;
  /** All four token columns summed; null when the span recorded none. */
  tokens: number | null;
  costUsd: number | null;
  usageUnknown: boolean;
  durationMs: number | null;
  /** Already filtered for sensitive keys by the writer. */
  attributes: Record<string, unknown>;
}

export interface RateLimitWindowReading {
  name: string;
  /** Fraction of the window used, 0..1. */
  utilization: number;
  resetsAtMs: number | null;
}

export interface HarnessEventRow extends EventBase {
  source: 'harness';
  kind: string;
  invocationId: string | null;
  atMs: number | null;
  toolName: string | null;
  path: string | null;
  exitCode: number | null;
  isError: boolean | null;
  phase: string | null;
  rateLimitWindows: RateLimitWindowReading[] | null;
}

export type WatchEvent = CardLogEvent | JournalSpanEvent | HarnessEventRow;

/** One row of the state DB `cards` table. */
export interface CardSnapshot {
  id: string;
  parentId: string | null;
  lane: string;
  status: Status | string;
  attempt: number;
  wave: number;
  reworkCount: number | null;
  ownedPaths: string[];
  /** Epoch seconds; null when the card is dispatchable now. */
  releaseAt: number | null;
  /** From `active_workers.started_at`, epoch seconds, when a worker holds the card. */
  workerStartedAt: number | null;
}

/** The state DB as the reader last saw it. */
export interface StateSnapshot {
  cards: CardSnapshot[];
  run: RunSnapshot | null;
}

export interface RunSnapshot {
  runId: string;
  flow: string;
  status: string;
  outcome: string | null;
  /** Epoch seconds. */
  createdAt: number;
}
